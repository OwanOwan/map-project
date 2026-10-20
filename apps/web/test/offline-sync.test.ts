/**
 * @file offline-sync.test.ts
 *
 * Verifies the complete offline-first report flow:
 *
 *  Scenario:
 *   1. Simulate "airplane mode" by making all fetch() calls throw a
 *      NetworkError (TypeError: Failed to fetch).
 *   2. Submit three incident reports via the SyncEngine.
 *      → All three are stored in the queue with status 'queued'.
 *      → The immediate sync() attempt marks each 'failed' (network down).
 *   3. "Restore connectivity" by resetting fetch() to a working stub.
 *   4. Call sync() once.
 *      → All three arrive at the server exactly once.
 *      → No duplicate rows appear (idempotency via clientId).
 *      → All three queue items end up with status 'sent'.
 *
 * Implementation notes:
 *  - We do NOT use a real browser environment or service worker here.
 *    The test exercises OfflineQueue (in-memory fake) + SyncEngine directly.
 *  - IndexedDB is replaced with a simple in-memory fake so the test
 *    runs in Node.js under Vitest without jsdom.
 *  - The server side is replaced with an InMemoryIncidentRepository so we can
 *    assert on the stored incidents without a running Postgres instance.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { SyncEngine } from '../src/sync-engine.js';
import { OfflineQueue, QueuedReport, QueuedStatus } from '../src/offline-queue.js';

// ─────────────────────────────────────────────────────────────────────────────
// In-memory OfflineQueue (replaces IndexedDB for Node.js tests)
// ─────────────────────────────────────────────────────────────────────────────

class FakeOfflineQueue implements OfflineQueue {
  private store: Map<string, QueuedReport> = new Map();

  async enqueue(
    clientId: string,
    payload: QueuedReport['payload'],
  ): Promise<QueuedReport> {
    const item: QueuedReport = {
      clientId,
      payload: { ...payload, clientId },
      status: 'queued',
      createdAt: new Date().toISOString(),
      attempt: 0,
    };
    this.store.set(clientId, item);
    return { ...item };
  }

  async get(clientId: string): Promise<QueuedReport | undefined> {
    const item = this.store.get(clientId);
    return item ? { ...item } : undefined;
  }

  async list(status?: QueuedStatus): Promise<QueuedReport[]> {
    const all = Array.from(this.store.values());
    return status ? all.filter((i) => i.status === status) : all;
  }

  async markSending(clientId: string): Promise<boolean> {
    const item = this.store.get(clientId);
    if (!item || item.status === 'sent') return false;
    this.store.set(clientId, {
      ...item,
      status: 'sending',
      lastAttemptAt: new Date().toISOString(),
    });
    return true;
  }

  async markSent(clientId: string, serverId: string): Promise<void> {
    const item = this.store.get(clientId);
    if (!item) return;
    this.store.set(clientId, { ...item, status: 'sent', serverId });
  }

  async markFailed(clientId: string, error: string): Promise<void> {
    const item = this.store.get(clientId);
    if (!item) return;
    const nextAttempt = item.attempt + 1;
    // Short back-off in tests (1 ms) so retries happen immediately
    const nextRetryAt = new Date(Date.now() + 1).toISOString();
    this.store.set(clientId, {
      ...item,
      status: 'failed',
      attempt: nextAttempt,
      lastError: error,
      nextRetryAt,
    });
  }

  async requeue(clientId: string): Promise<void> {
    const item = this.store.get(clientId);
    if (!item || item.status === 'sent') return;
    this.store.set(clientId, { ...item, status: 'queued', nextRetryAt: undefined });
  }

  async remove(clientId: string): Promise<void> {
    this.store.delete(clientId);
  }

  async clear(): Promise<void> {
    this.store.clear();
  }

  async getDueForSync(): Promise<QueuedReport[]> {
    const now = Date.now();
    return Array.from(this.store.values()).filter((item) => {
      if (item.status === 'sent' || item.status === 'sending') return false;
      if (item.status === 'queued') return true;
      return !item.nextRetryAt || new Date(item.nextRetryAt).getTime() <= now;
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// In-memory "server" — tracks received incidents and enforces clientId uniqueness
// ─────────────────────────────────────────────────────────────────────────────

interface ServerIncident {
  id: string;
  clientId?: string;
  title: string;
  latitude: number;
  longitude: number;
}

class FakeServer {
  private incidents: ServerIncident[] = [];
  /** clientId → server-id dedup map */
  private clientIdIndex: Map<string, string> = new Map();

  /**
   * Simulate POST /api/v1/incidents.
   * Returns { id, clientId, ... } on success.
   * Idempotent: second call with the same clientId returns the original record.
   */
  handlePost(body: Record<string, unknown>): { status: number; body: Record<string, unknown> } {
    const clientId = typeof body['clientId'] === 'string' ? body['clientId'] : undefined;

    if (clientId) {
      const existing = this.clientIdIndex.get(clientId);
      if (existing) {
        // Idempotent — return original incident
        const incident = this.incidents.find((i) => i.id === existing)!;
        return { status: 200, body: this.toFeature(incident) };
      }
    }

    const id = `server-${this.incidents.length + 1}`;
    const incident: ServerIncident = {
      id,
      clientId,
      title: body['title'] as string,
      latitude: body['latitude'] as number,
      longitude: body['longitude'] as number,
    };
    this.incidents.push(incident);
    if (clientId) this.clientIdIndex.set(clientId, id);

    return { status: 201, body: this.toFeature(incident) };
  }

  private toFeature(i: ServerIncident): Record<string, unknown> {
    return {
      type: 'Feature',
      id: i.id,
      geometry: { type: 'Point', coordinates: [i.longitude, i.latitude] },
      properties: { id: i.id, clientId: i.clientId, title: i.title },
    };
  }

  count(): number {
    return this.incidents.length;
  }

  all(): ServerIncident[] {
    return [...this.incidents];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Test suite
// ─────────────────────────────────────────────────────────────────────────────

describe('Offline-first report flow', () => {
  let fakeQueue: FakeOfflineQueue;
  let fakeServer: FakeServer;
  let engine: SyncEngine;

  /** Three distinct incident payloads representing the queued-while-offline reports */
  const incidents = [
    {
      clientId: '00000000-0000-0000-0000-000000000001',
      payload: {
        title: 'Fallen tree blocking road',
        type: 'hazard' as const,
        severity: 3,
        description: 'Large tree across the carriageway near bus stop',
        latitude: 51.5074,
        longitude: -0.1278,
        landmark: 'Bus stop 14, Oxford St',
        source: 'user' as const,
        clientId: '00000000-0000-0000-0000-000000000001',
      },
    },
    {
      clientId: '00000000-0000-0000-0000-000000000002',
      payload: {
        title: 'Flooded underpass',
        type: 'hazard' as const,
        severity: 4,
        description: 'Water level knee-high, road impassable',
        latitude: 51.5080,
        longitude: -0.1290,
        landmark: 'Marble Arch underpass, junction with Park Lane',
        source: 'user' as const,
        clientId: '00000000-0000-0000-0000-000000000002',
      },
    },
    {
      clientId: '00000000-0000-0000-0000-000000000003',
      payload: {
        title: 'Suspicious package reported',
        type: 'crime' as const,
        severity: 5,
        description: 'Unattended bag outside main entrance',
        latitude: 51.5090,
        longitude: -0.1300,
        landmark: 'Victoria Station main entrance',
        source: 'user' as const,
        clientId: '00000000-0000-0000-0000-000000000003',
      },
    },
  ];

  beforeEach(() => {
    fakeQueue = new FakeOfflineQueue();
    fakeServer = new FakeServer();

    engine = new SyncEngine({
      apiBaseUrl: 'http://fake-api',
      queue: fakeQueue as unknown as OfflineQueue,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it(
    'submits three reports in airplane mode, reconnects, and confirms all three arrive exactly once with no duplicates',
    async () => {
      // ── Phase 1: Airplane mode ──────────────────────────────────────────────
      // Replace global fetch with one that always throws a network error
      const networkError = new TypeError('Failed to fetch');
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(networkError));

      // Enqueue all three reports (simulates offline submission)
      for (const { clientId, payload } of incidents) {
        await engine.enqueue(clientId, payload);
      }

      // Verify all three are in the queue with status 'queued'
      const queuedItems = await fakeQueue.list();
      expect(queuedItems).toHaveLength(3);
      expect(queuedItems.every((i) => i.status === 'queued')).toBe(true);

      // Attempt a sync while still offline — should mark all as 'failed'
      await engine.sync();

      const afterOfflineSync = await fakeQueue.list();
      expect(afterOfflineSync).toHaveLength(3);
      expect(afterOfflineSync.every((i) => i.status === 'failed')).toBe(true);

      // Server should have received nothing yet
      expect(fakeServer.count()).toBe(0);

      // ── Phase 2: Restore connectivity ──────────────────────────────────────
      // Replace fetch with a working stub that delegates to FakeServer
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
          if (init?.method === 'POST' && String(url).includes('/api/v1/incidents')) {
            const body = JSON.parse(init.body as string);
            const { status, body: responseBody } = fakeServer.handlePost(body);
            return new Response(JSON.stringify(responseBody), {
              status,
              headers: { 'Content-Type': 'application/json' },
            });
          }
          throw new Error(`Unexpected fetch: ${url}`);
        }),
      );

      // Advance time past the back-off window (our fake uses 1 ms back-off)
      await new Promise((r) => setTimeout(r, 5));

      // ── Phase 3: Reconnect sync ─────────────────────────────────────────────
      const syncResult = await engine.sync();

      // All three must have been sent in this pass
      expect(syncResult.sent).toBe(3);
      expect(syncResult.failed).toBe(0);

      // ── Phase 4: Assert server-side exactly-once delivery ──────────────────
      expect(fakeServer.count()).toBe(3);

      const serverIncidents = fakeServer.all();
      const clientIds = serverIncidents.map((i) => i.clientId);

      // All three original clientIds are present
      expect(clientIds).toContain('00000000-0000-0000-0000-000000000001');
      expect(clientIds).toContain('00000000-0000-0000-0000-000000000002');
      expect(clientIds).toContain('00000000-0000-0000-0000-000000000003');

      // No duplicate clientIds
      const uniqueClientIds = new Set(clientIds.filter(Boolean));
      expect(uniqueClientIds.size).toBe(3);

      // ── Phase 5: Retry simulation — calling sync() again must not duplicate ─
      // (simulates what happens if the SW retries or the user goes online twice)
      const retrySyncResult = await engine.sync();
      expect(retrySyncResult.sent).toBe(0); // nothing left to send
      expect(fakeServer.count()).toBe(3);   // still exactly 3 on the server

      // ── Phase 6: Assert all queue items end as 'sent' ───────────────────────
      const finalItems = await fakeQueue.list();
      expect(finalItems).toHaveLength(3);
      expect(finalItems.every((i) => i.status === 'sent')).toBe(true);

      // Each item must have the server-assigned ID stored
      expect(finalItems.every((i) => typeof i.serverId === 'string')).toBe(true);
    },
  );

  it('correctly emits status-changed events for each transition', async () => {
    const events: Array<{ clientId: string; status: QueuedStatus }> = [];

    engine.subscribe((event) => {
      if (event.type === 'status-changed') {
        events.push({
          clientId: event.report.clientId,
          status: event.report.status,
        });
      }
    });

    // Offline
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    const { clientId, payload } = incidents[0];
    await engine.enqueue(clientId, payload);
    await engine.sync();

    // Online
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(init?.body as string);
        const { status, body: responseBody } = fakeServer.handlePost(body);
        return new Response(JSON.stringify(responseBody), { status });
      }),
    );

    await new Promise((r) => setTimeout(r, 5));
    await engine.sync();

    // Expect: queued → (sending → failed) → sending → sent
    const statusSequence = events
      .filter((e) => e.clientId === clientId)
      .map((e) => e.status);

    expect(statusSequence).toContain('queued');
    expect(statusSequence).toContain('failed');
    expect(statusSequence).toContain('sending');
    expect(statusSequence).toContain('sent');

    // 'sent' must come last
    expect(statusSequence[statusSequence.length - 1]).toBe('sent');
  });

  it('re-submitting the same clientId during sync does not create a duplicate on the server', async () => {
    const { clientId, payload } = incidents[0];

    // Online from the start
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(init?.body as string);
        const { status, body: responseBody } = fakeServer.handlePost(body);
        return new Response(JSON.stringify(responseBody), { status });
      }),
    );

    // Manually insert the same item twice (simulates a stuck 'queued' state)
    await fakeQueue.enqueue(clientId, payload);
    // Reset to queued so getDueForSync picks it up again
    await fakeQueue.requeue(clientId);

    await engine.sync();

    // Still only one submission to the server
    expect(fakeServer.count()).toBe(1);

    // Second sync (all items already 'sent') must not send again
    const second = await engine.sync();
    expect(second.sent).toBe(0);
    expect(fakeServer.count()).toBe(1);
  });
});
