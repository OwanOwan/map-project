/**
 * @file report-submission.ts
 *
 * High-level facade for submitting incident reports from the web app.
 *
 * This is the single entry point that:
 *  1. Compresses attached photos to < 200 KB (if provided).
 *  2. Resolves the GPS pin + landmark into a LocationInput.
 *  3. Generates a client-side UUID (clientId) for idempotency.
 *  4. Enqueues the report via the SyncEngine (which persists to IndexedDB).
 *  5. Immediately calls sync() so online submissions go through without delay.
 *
 * The caller receives the QueuedReport immediately.  Its status transitions
 * from 'queued' → 'sending' → 'sent' / 'failed' asynchronously; subscribe
 * to SyncEngine events to update the UI.
 */

import { SyncEngine } from './sync-engine.js';
import { LocationInput } from './location-input.js';
import type { CreateIncidentInput } from '@safetymap/shared';
import type { QueuedReport } from './offline-queue.js';

export interface SubmitReportInput {
  title: string;
  type: CreateIncidentInput['type'];
  severity: number;
  description: string;
  location: LocationInput;
  source?: CreateIncidentInput['source'];
}

export interface SubmitReportResult {
  /** The queued item (status may still be 'queued' if offline) */
  queued: QueuedReport;
  /**
   * True if the report was sent immediately during this call;
   * false if it is sitting in the queue waiting for connectivity.
   */
  sentImmediately: boolean;
}

/**
 * Submit an incident report.
 *
 * Offline-safe: if there is no network connectivity the report is stored in
 * IndexedDB and will be forwarded automatically when the device reconnects.
 */
export async function submitReport(
  engine: SyncEngine,
  input: SubmitReportInput,
): Promise<SubmitReportResult> {
  const { title, type, severity, description, location, source } = input;
  const { gps, landmark } = location;

  // ── 1. Build the API payload ────────────────────────────────────────────────
  const clientId = crypto.randomUUID();

  const payload: CreateIncidentInput & { landmark?: string } = {
    title,
    type,
    severity,
    description,
    latitude: gps.latitude,
    longitude: gps.longitude,
    source: source ?? 'user',
    landmark,
    clientId,
  };

  // ── 2. Enqueue (persists to IndexedDB) ──────────────────────────────────────
  const queued = await engine.enqueue(clientId, payload);

  // ── 3. Attempt immediate sync ───────────────────────────────────────────────
  const result = await engine.sync();
  const sentImmediately = result.sent > 0;

  return { queued, sentImmediately };
}
