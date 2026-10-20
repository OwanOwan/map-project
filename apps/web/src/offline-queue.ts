/**
 * @file offline-queue.ts
 *
 * IndexedDB-backed queue for incident reports submitted while offline.
 *
 * Each queued item transitions through these statuses:
 *
 *   queued ──► sending ──► sent
 *                    └──► failed  (retried with exponential back-off)
 *
 * The queue uses a monotonically increasing `attempt` counter and a
 * `nextRetryAt` timestamp to implement truncated-exponential back-off with
 * full jitter (as recommended by AWS Architecture Blog):
 *
 *   delay = min(CAP, BASE * 2^attempt) × rand(0.5, 1)
 *   CAP   = 5 minutes
 *   BASE  = 1 second
 *
 * De-duplication is enforced via `clientId` (UUID v4 generated when the
 * item is first queued).  The same `clientId` is forwarded to the server in
 * the request body; the server stores it in `incidents.client_id` (UNIQUE)
 * so retried submissions never create duplicate rows.
 */

import type { CreateIncidentInput } from '@safetymap/shared';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type QueuedStatus = 'queued' | 'sending' | 'sent' | 'failed';

export interface QueuedReport {
  /** UUID v4 generated client-side — doubles as idempotency key for the API */
  clientId: string;
  /** Full incident payload ready to POST */
  payload: CreateIncidentInput & { landmark?: string };
  status: QueuedStatus;
  /** ISO timestamp of when the item was first enqueued */
  createdAt: string;
  /** ISO timestamp of the last attempt (undefined = never tried) */
  lastAttemptAt?: string;
  /** Total number of send attempts (0 = never tried) */
  attempt: number;
  /** ISO timestamp after which a retry is allowed (undefined = immediately) */
  nextRetryAt?: string;
  /** Error message from the last failed attempt */
  lastError?: string;
  /** Server-assigned incident ID once successfully submitted */
  serverId?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DB_NAME = 'safetymap';
const DB_VERSION = 1;
const STORE_NAME = 'pending_reports';

/** Exponential back-off: BASE * 2^attempt, capped at CAP, with ±50 % jitter */
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 5 * 60 * 1_000; // 5 minutes

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function nextBackoffMs(attempt: number): number {
  const exp = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * Math.pow(2, attempt));
  // Full jitter: uniform random in [exp/2, exp]
  return Math.floor(exp * 0.5 + Math.random() * exp * 0.5);
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'clientId' });
        store.createIndex('by_status', 'status', { unique: false });
        store.createIndex('by_createdAt', 'createdAt', { unique: false });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// OfflineQueue – public API
// ─────────────────────────────────────────────────────────────────────────────

export class OfflineQueue {
  private dbPromise: Promise<IDBDatabase>;

  constructor() {
    this.dbPromise = openDB();
  }

  /** Add a new report to the queue (status = 'queued'). */
  async enqueue(
    clientId: string,
    payload: CreateIncidentInput & { landmark?: string },
  ): Promise<QueuedReport> {
    const db = await this.dbPromise;

    const item: QueuedReport = {
      clientId,
      payload: { ...payload, clientId },
      status: 'queued',
      createdAt: new Date().toISOString(),
      attempt: 0,
    };

    const tx = db.transaction(STORE_NAME, 'readwrite');
    await idbRequest(tx.objectStore(STORE_NAME).put(item));
    return item;
  }

  /** Retrieve a single item by its clientId. */
  async get(clientId: string): Promise<QueuedReport | undefined> {
    const db = await this.dbPromise;
    const tx = db.transaction(STORE_NAME, 'readonly');
    return idbRequest<QueuedReport | undefined>(
      tx.objectStore(STORE_NAME).get(clientId) as IDBRequest<QueuedReport | undefined>,
    );
  }

  /** List all items, optionally filtered by status. */
  async list(status?: QueuedStatus): Promise<QueuedReport[]> {
    const db = await this.dbPromise;
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);

    if (status) {
      const idx = store.index('by_status');
      return idbRequest<QueuedReport[]>(
        idx.getAll(status) as IDBRequest<QueuedReport[]>,
      );
    }

    return idbRequest<QueuedReport[]>(
      store.getAll() as IDBRequest<QueuedReport[]>,
    );
  }

  /**
   * Mark an item as 'sending' (called just before the fetch fires).
   * Returns false if the item no longer exists or is already 'sent'.
   */
  async markSending(clientId: string): Promise<boolean> {
    const db = await this.dbPromise;
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);

    const item = await idbRequest<QueuedReport | undefined>(
      store.get(clientId) as IDBRequest<QueuedReport | undefined>,
    );
    if (!item || item.status === 'sent') return false;

    const updated: QueuedReport = {
      ...item,
      status: 'sending',
      lastAttemptAt: new Date().toISOString(),
    };
    await idbRequest(store.put(updated));
    return true;
  }

  /**
   * Mark a successfully submitted item as 'sent'.
   * @param serverId - The server-assigned incident UUID echoed back in the response.
   */
  async markSent(clientId: string, serverId: string): Promise<void> {
    const db = await this.dbPromise;
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);

    const item = await idbRequest<QueuedReport | undefined>(
      store.get(clientId) as IDBRequest<QueuedReport | undefined>,
    );
    if (!item) return;

    const updated: QueuedReport = {
      ...item,
      status: 'sent',
      serverId,
    };
    await idbRequest(store.put(updated));
  }

  /**
   * Mark a failed attempt.
   * Increments the attempt counter, computes the next retry window with
   * truncated-exponential back-off + full jitter, and sets status = 'failed'.
   */
  async markFailed(clientId: string, error: string): Promise<void> {
    const db = await this.dbPromise;
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);

    const item = await idbRequest<QueuedReport | undefined>(
      store.get(clientId) as IDBRequest<QueuedReport | undefined>,
    );
    if (!item) return;

    const nextAttempt = item.attempt + 1;
    const delayMs = nextBackoffMs(nextAttempt);

    const updated: QueuedReport = {
      ...item,
      status: 'failed',
      attempt: nextAttempt,
      lastError: error,
      nextRetryAt: new Date(Date.now() + delayMs).toISOString(),
    };
    await idbRequest(store.put(updated));
  }

  /**
   * Reset a 'failed' item back to 'queued' so the sync loop picks it up.
   * No-ops if the item is already 'sent'.
   */
  async requeue(clientId: string): Promise<void> {
    const db = await this.dbPromise;
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);

    const item = await idbRequest<QueuedReport | undefined>(
      store.get(clientId) as IDBRequest<QueuedReport | undefined>,
    );
    if (!item || item.status === 'sent') return;

    const updated: QueuedReport = { ...item, status: 'queued', nextRetryAt: undefined };
    await idbRequest(store.put(updated));
  }

  /** Delete a single item (use sparingly; prefer markSent). */
  async remove(clientId: string): Promise<void> {
    const db = await this.dbPromise;
    const tx = db.transaction(STORE_NAME, 'readwrite');
    await idbRequest(tx.objectStore(STORE_NAME).delete(clientId));
  }

  /** Delete ALL items — used only in tests. */
  async clear(): Promise<void> {
    const db = await this.dbPromise;
    const tx = db.transaction(STORE_NAME, 'readwrite');
    await idbRequest(tx.objectStore(STORE_NAME).clear());
  }

  /**
   * Returns items that are due for retry:
   *  - status === 'queued', OR
   *  - status === 'failed' AND nextRetryAt <= now
   */
  async getDueForSync(): Promise<QueuedReport[]> {
    const all = await this.list();
    const now = Date.now();
    return all.filter((item) => {
      if (item.status === 'sent' || item.status === 'sending') return false;
      if (item.status === 'queued') return true;
      // failed: only retry after the back-off window has elapsed
      return !item.nextRetryAt || new Date(item.nextRetryAt).getTime() <= now;
    });
  }
}
