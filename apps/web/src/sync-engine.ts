/**
 * @file sync-engine.ts
 *
 * Drives the offline→online synchronisation loop.
 *
 * Responsibilities:
 *  1. On `navigator.onLine` transitions (or explicit `sync()` calls), drain
 *     the IndexedDB queue of all items that are due for submission.
 *  2. POST each item to the API with its `clientId` as the idempotency key.
 *  3. On success  → mark the item `sent`  (stores the server-assigned ID).
 *  4. On network/server failure → mark the item `failed` (back-off applied by
 *     the queue; the next `sync()` call will only pick it up after the window).
 *  5. Emit lifecycle events so the UI can update status badges without polling.
 *
 * The service worker calls `sync()` in response to the Background Sync API's
 * `sync` event.  The page can also call `sync()` directly whenever it detects
 * connectivity (e.g. on the `online` DOM event).
 */

import { OfflineQueue, QueuedReport } from './offline-queue.js';

// ─────────────────────────────────────────────────────────────────────────────
// Events
// ─────────────────────────────────────────────────────────────────────────────

export type SyncEventType = 'status-changed' | 'sync-complete';

export interface SyncStatusChangedEvent {
  type: 'status-changed';
  report: QueuedReport;
}

export interface SyncCompleteEvent {
  type: 'sync-complete';
  /** Number of items successfully sent in this pass */
  sent: number;
  /** Number of items that failed and will be retried later */
  failed: number;
}

export type SyncEvent = SyncStatusChangedEvent | SyncCompleteEvent;

type SyncListener = (event: SyncEvent) => void;

// ─────────────────────────────────────────────────────────────────────────────
// SyncEngine
// ─────────────────────────────────────────────────────────────────────────────

export interface SyncEngineOptions {
  /** Fastify API base URL, e.g. http://localhost:3001 */
  apiBaseUrl: string;
  /** Optional Bearer token for authenticated users */
  authToken?: string;
  /** Injected queue instance (useful in tests) */
  queue?: OfflineQueue;
}

export class SyncEngine {
  private readonly queue: OfflineQueue;
  private readonly apiBaseUrl: string;
  private authToken?: string;
  private listeners: SyncListener[] = [];
  private syncing = false;

  constructor(options: SyncEngineOptions) {
    this.apiBaseUrl = options.apiBaseUrl.replace(/\/$/, '');
    this.authToken = options.authToken;
    this.queue = options.queue ?? new OfflineQueue();
  }

  // ── Subscription ───────────────────────────────────────────────────────────

  subscribe(fn: SyncListener): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }

  private emit(event: SyncEvent): void {
    for (const fn of this.listeners) {
      try { fn(event); } catch { /* swallow listener errors */ }
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Update the auth token (e.g. after login). */
  setAuthToken(token: string | undefined): void {
    this.authToken = token;
  }

  /**
   * Add a new incident report to the offline queue.
   * Returns the queued item immediately (status = 'queued').
   * Call `sync()` afterwards if online.
   */
  async enqueue(
    clientId: string,
    payload: QueuedReport['payload'],
  ): Promise<QueuedReport> {
    const item = await this.queue.enqueue(clientId, payload);
    this.emit({ type: 'status-changed', report: item });
    return item;
  }

  /** Get all items in the queue. */
  listAll(): Promise<QueuedReport[]> {
    return this.queue.list();
  }

  /**
   * Drain the queue: submit all due items to the API.
   * Safe to call concurrently — a second call while one is in progress is a
   * no-op that resolves immediately.
   */
  async sync(): Promise<SyncCompleteEvent> {
    if (this.syncing) {
      return { type: 'sync-complete', sent: 0, failed: 0 };
    }
    this.syncing = true;

    let sent = 0;
    let failed = 0;

    try {
      const due = await this.queue.getDueForSync();

      for (const item of due) {
        const success = await this.submitOne(item);
        if (success) sent++;
        else failed++;
      }
    } finally {
      this.syncing = false;
    }

    const event: SyncCompleteEvent = { type: 'sync-complete', sent, failed };
    this.emit(event);
    return event;
  }

  // ── Internal helpers ───────────────────────────────────────────────────────

  private async submitOne(item: QueuedReport): Promise<boolean> {
    const ok = await this.queue.markSending(item.clientId);
    if (!ok) return false; // already sent or removed

    const sendingItem = await this.queue.get(item.clientId);
    if (sendingItem) this.emit({ type: 'status-changed', report: sendingItem });

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        // Echo the clientId in the header as well — some proxy layers log it
        'X-Idempotency-Key': item.clientId,
      };
      if (this.authToken) {
        headers['Authorization'] = `Bearer ${this.authToken}`;
      }

      const response = await fetch(`${this.apiBaseUrl}/api/v1/incidents`, {
        method: 'POST',
        headers,
        body: JSON.stringify(item.payload),
      });

      if (response.ok) {
        const feature = await response.json();
        const serverId: string = feature?.id ?? feature?.properties?.id ?? item.clientId;
        await this.queue.markSent(item.clientId, serverId);

        const sentItem = await this.queue.get(item.clientId);
        if (sentItem) this.emit({ type: 'status-changed', report: sentItem });

        return true;
      }

      // Non-2xx — treat as a transient failure so we retry
      const errorText = await response.text().catch(() => `HTTP ${response.status}`);
      await this.queue.markFailed(item.clientId, `HTTP ${response.status}: ${errorText}`);

      const failedItem = await this.queue.get(item.clientId);
      if (failedItem) this.emit({ type: 'status-changed', report: failedItem });

      return false;
    } catch (err) {
      // Network error / offline
      const message = err instanceof Error ? err.message : String(err);
      await this.queue.markFailed(item.clientId, message);

      const failedItem = await this.queue.get(item.clientId);
      if (failedItem) this.emit({ type: 'status-changed', report: failedItem });

      return false;
    }
  }
}
