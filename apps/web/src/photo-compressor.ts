/**
 * @file photo-compressor.ts
 *
 * Client-side image compression using the Canvas API.
 *
 * Algorithm:
 *  1. Decode the source File/Blob into an HTMLImageElement.
 *  2. Scale the image so its larger dimension is ≤ MAX_DIMENSION (1280 px).
 *  3. Re-encode as JPEG at an initial quality of INITIAL_QUALITY (0.85).
 *  4. If the result still exceeds TARGET_MAX_BYTES (200 KB), iteratively
 *     lower quality by QUALITY_STEP (0.1) until the size fits or quality
 *     reaches MIN_QUALITY (0.1) — whichever comes first.
 *
 * Assumptions:
 *  - Runs in a browser context with Canvas and Blob support.
 *  - Input is any image MIME type that <img> can decode (JPEG, PNG, WebP, HEIC
 *    if the browser supports it, etc.).
 *  - Output is always a JPEG Blob (smallest lossy format with broad support).
 *  - EXIF orientation is applied automatically by the browser when decoding
 *    into <img>; no separate EXIF library is needed.
 */

const TARGET_MAX_BYTES = 200 * 1024; // 200 KB
const MAX_DIMENSION = 1280;          // px — longest edge
const INITIAL_QUALITY = 0.85;
const QUALITY_STEP = 0.10;
const MIN_QUALITY = 0.10;

/**
 * Result of a compression pass.
 */
export interface CompressionResult {
  blob: Blob;
  /** Final size in bytes */
  sizeBytes: number;
  /** JPEG quality used for the final encode (0–1) */
  quality: number;
  /** Scale factor applied (1 = no resize) */
  scale: number;
  /** Whether the output fits within TARGET_MAX_BYTES */
  withinTarget: boolean;
}

/**
 * Compress a photo to under 200 KB.
 *
 * @param source - The original image File or Blob.
 * @returns A CompressionResult with the compressed JPEG Blob.
 * @throws If the image cannot be decoded or the Canvas is unavailable.
 */
export async function compressPhoto(source: File | Blob): Promise<CompressionResult> {
  const img = await loadImage(source);

  // ── Scale so the longest dimension ≤ MAX_DIMENSION ─────────────────────────
  const scale = Math.min(1, MAX_DIMENSION / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.round(img.naturalWidth * scale);
  const h = Math.round(img.naturalHeight * scale);

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('compressPhoto: Canvas 2D context unavailable');
  ctx.drawImage(img, 0, 0, w, h);

  // ── Iteratively reduce quality until size fits ─────────────────────────────
  let quality = INITIAL_QUALITY;
  let blob = await canvasToBlob(canvas, 'image/jpeg', quality);

  while (blob.size > TARGET_MAX_BYTES && quality > MIN_QUALITY) {
    quality = Math.max(MIN_QUALITY, quality - QUALITY_STEP);
    blob = await canvasToBlob(canvas, 'image/jpeg', quality);
  }

  return {
    blob,
    sizeBytes: blob.size,
    quality,
    scale,
    withinTarget: blob.size <= TARGET_MAX_BYTES,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

function loadImage(source: File | Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(source);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('compressPhoto: Failed to decode image'));
    };
    img.src = url;
  });
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error('compressPhoto: canvas.toBlob returned null'));
      },
      type,
      quality,
    );
  });
}
