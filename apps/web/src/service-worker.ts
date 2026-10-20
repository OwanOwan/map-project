/**
 * @file service-worker.ts
 *
 * SafetyMap Service Worker
 * ──────────────────────────────────────────────────────────────────────────
 * Responsibilities:
 *  1. Intercept POST /api/v1/incidents — if offline, enqueue in IndexedDB and
 *     return a synthetic 202 Accepted so the page always gets a response.
 *  2. Register a Background Sync tag ('sync-incidents') so the browser retries
 *     automatically as soon as connectivity is restored.
 *  3. On the `sync` event, call the SyncEngine to drain the queue.
 *  4. Send `status-changed` postMessages to all open clients so the UI can
 *     update status badges in real time.
 *
 * Notes / assumptions:
 *  - The SW imports the same OfflineQueue and SyncEngine used by the page.
 *    This is safe because both sides talk to the same IndexedDB store.
 *  - The API_BASE_URL is baked in at build time via the SW_API_BASE env
 *    variable; override it in your build pipeline.
 *  - Cache-first strategies for static assets are intentionally omitted from
 *    this file to keep the scope on offline *submission* only.
 */

/// <reference lib="webworker" />
declare const self: ServiceWorkerGlobalScope;

import { OfflineQueue } from './offline-queue.js';
import { SyncEngine } from './sync-engine.js';

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const API_BASE_URL =
  (typeof process !== 'undefined' && (process.env as Record<string, string>)['SW_API_BASE']) ||
  'http://localhost:3001';

const SYNC_TAG = 'sync-incidents';

// ─────────────────────────────────────────────────────────────────────────────
// Shared instances (singleton per SW context)
// ─────────────────────────────────────────────────────────────────────────────

const queue = new OfflineQueue();
const engine = new SyncEngine({ apiBaseUrl: API_BASE_URL, queue });

// Forward status events to all open clients
engine.subscribe(async (event) => {
  const clients = await self.clients.matchAll({ type: 'window' });
  for (const client of clients) {
    client.postMessage(event);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Install / Activate
// ─────────────────────────────────────────────────────────────────────────────

self.addEventListener('install', () => {
  // Skip waiting so the new SW activates immediately
  self.skipWaiting();
});

self.addEventListener('activate', (event: ExtendableEvent) => {
  // Take control of all open clients immediately
  event.waitUntil(self.clients.claim());
});

// ─────────────────────────────────────────────────────────────────────────────
// Fetch interception — POST /api/v1/incidents
// ─────────────────────────────────────────────────────────────────────────────

self.addEventListener('fetch', (event: FetchEvent) => {
  const { request } = event;

  // Only intercept JSON POST to our incidents endpoint
  if (
    request.method !== 'POST' ||
    !request.url.includes('/api/v1/incidents')
  ) {
    return; // let the browser handle it
  }

  event.respondWith(handleIncidentPost(request));
});

async function handleIncidentPost(request: Request): Promise<Response> {
  // Try the network first
  try {
    const cloned = request.clone();
    const networkResponse = await fetch(cloned);
    return networkResponse;
  } catch {
    // Network unavailable — queue the report
    return await queueReport(request);
  }
}

async function queueReport(request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return new Response(
      JSON.stringify({ error: 'Could not parse request body' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // Guarantee a clientId — generate one if the page didn't supply it
  const clientId: string =
    (typeof body['clientId'] === 'string' && body['clientId']) ||
    crypto.randomUUID();

  await engine.enqueue(clientId, body as Parameters<typeof engine.enqueue>[1]);

  // Register for background sync (best effort — may not be supported in all browsers)
  try {
    await (self.registration as ServiceWorkerRegistration & {
      sync: { register(tag: string): Promise<void> };
    }).sync.register(SYNC_TAG);
  } catch {
    // Background Sync not supported; the page `online` listener will call sync()
  }

  // Return a 202 Accepted so the page code knows the report was queued
  return new Response(
    JSON.stringify({
      queued: true,
      clientId,
      message: 'Report queued for submission when connectivity is restored',
    }),
    {
      status: 202,
      headers: { 'Content-Type': 'application/json' },
    },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Background Sync event
// ─────────────────────────────────────────────────────────────────────────────

self.addEventListener('sync', (event) => {
  const syncEvent = event as SyncEvent & ExtendableEvent;
  if (syncEvent.tag === SYNC_TAG) {
    syncEvent.waitUntil(engine.sync());
  }
});

// Support browsers that implement sync as a SyncEvent
interface SyncEvent extends ExtendableEvent {
  readonly tag: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Message handling — allow the page to trigger sync manually
// ─────────────────────────────────────────────────────────────────────────────

self.addEventListener('message', (event: ExtendableMessageEvent) => {
  if (event.data?.type === 'SYNC_NOW') {
    event.waitUntil(engine.sync());
  }
});
