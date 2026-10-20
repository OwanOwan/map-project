/**
 * @file location-input.ts
 *
 * Landmark-friendly location input utilities.
 *
 * The SafetyMap report form uses two complementary location inputs:
 *
 *  1. GPS pin  — obtained from the Geolocation API (or provided manually by
 *               tapping a map).  Stored as { latitude, longitude }.
 *
 *  2. Landmark — optional free-text string (≤ 200 chars) describing a
 *               recognisable point near the incident, e.g.:
 *               "Shell station at Broad St & 5th Ave junction"
 *               This field is submitted to the API as `landmark` and stored
 *               in incidents.landmark for display alongside the pin.
 *
 * Assumption: GPS is preferred but not mandatory.  If the user has no signal
 * the form should still accept a manually-typed address or landmark.  In that
 * case latitude/longitude must be obtained by another means (e.g. geocoding)
 * before the report is submitted.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface GpsCoordinates {
  latitude: number;
  longitude: number;
  /** Accuracy in metres (from Geolocation API) */
  accuracyMeters?: number;
  /** ISO timestamp of when the fix was taken */
  capturedAt: string;
}

export interface LocationInput {
  /** Required GPS coordinates */
  gps: GpsCoordinates;
  /**
   * Optional free-text landmark or junction name.
   * Validated to be ≤ 200 characters (matches schema constraint).
   */
  landmark?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// GPS acquisition
// ─────────────────────────────────────────────────────────────────────────────

export interface GetCurrentPositionOptions {
  /** Maximum age (ms) of a cached fix to accept (default: 30 000) */
  maximumAge?: number;
  /** Timeout (ms) before giving up (default: 10 000) */
  timeout?: number;
  /** Use high-accuracy mode (default: true) */
  enableHighAccuracy?: boolean;
}

/**
 * Acquire the device's current GPS position.
 *
 * @throws {GeolocationPositionError} if the user denies permission or the fix
 *   cannot be obtained within `timeout` ms.
 * @throws {Error} if the Geolocation API is not available (e.g. non-HTTPS).
 */
export function getCurrentPosition(
  opts: GetCurrentPositionOptions = {},
): Promise<GpsCoordinates> {
  if (!navigator.geolocation) {
    return Promise.reject(new Error('Geolocation API is not available'));
  }

  const {
    maximumAge = 30_000,
    timeout = 10_000,
    enableHighAccuracy = true,
  } = opts;

  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracyMeters: pos.coords.accuracy,
          capturedAt: new Date().toISOString(),
        }),
      reject,
      { maximumAge, timeout, enableHighAccuracy },
    );
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────────────

const MAX_LANDMARK_LENGTH = 200;

/**
 * Validate and normalise the landmark string.
 *
 * @returns The trimmed landmark, or undefined if empty/absent.
 * @throws {Error} if the landmark exceeds MAX_LANDMARK_LENGTH characters.
 */
export function normaliseLandmark(raw?: string): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > MAX_LANDMARK_LENGTH) {
    throw new Error(
      `Landmark must not exceed ${MAX_LANDMARK_LENGTH} characters (got ${trimmed.length})`,
    );
  }
  return trimmed;
}

/**
 * Build a LocationInput by combining GPS coordinates with an optional landmark.
 * Prefer this over constructing LocationInput manually — it normalises and
 * validates the landmark.
 */
export function buildLocationInput(
  gps: GpsCoordinates,
  landmark?: string,
): LocationInput {
  return {
    gps,
    landmark: normaliseLandmark(landmark),
  };
}
