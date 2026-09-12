/**
 * Cheap "did the screen change?" heuristic for watch mode.
 *
 * It works on the encoded frame (the base64 the capture worker already produced), not on
 * pixels, so it costs microseconds and no decoder. A signature is the base64 length plus 128
 * FNV-1a hashes, each over 32 characters sampled evenly across the string (4096 samples in
 * total). The difference between two frames is
 *
 *     max(|lenA − lenB| / max(lenA, lenB),  differing buckets / 128)
 *
 * Because JPEG is entropy coded, any pixel change perturbs the byte stream from that point
 * on, so this reliably says "unchanged" only for an unchanged (or near-identical) screen and
 * says "changed" for practically anything else — it cannot rank a small visual change against
 * a large one, and a change confined to the last rows of the image moves only the last buckets
 * (a few percent). DIFF_THRESHOLD is tuned for that: below 2 % the frame is treated as the same
 * screen and not sent to the model.
 */
export const DIFF_THRESHOLD = 0.02;
const SAMPLES = 4096;
const BUCKETS = 128;
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

export interface FrameSignature {
  length: number;
  buckets: Uint32Array;
}

export function frameSignature(base64: string): FrameSignature {
  const length = base64.length;
  const buckets = new Uint32Array(BUCKETS);
  if (length === 0) return { length, buckets };
  const samples = Math.min(SAMPLES, length);
  const perBucket = samples / BUCKETS;
  for (let b = 0; b < BUCKETS; b += 1) {
    let hash = FNV_OFFSET;
    const from = Math.floor(b * perBucket);
    const to = Math.floor((b + 1) * perBucket);
    for (let i = from; i < to; i += 1) {
      const index = Math.floor((i * length) / samples);
      hash ^= base64.charCodeAt(index);
      hash = Math.imul(hash, FNV_PRIME) >>> 0;
    }
    buckets[b] = hash;
  }
  return { length, buckets };
}

/** 0 = identical signatures, 1 = nothing in common. */
export function signatureDifference(a: FrameSignature, b: FrameSignature): number {
  const max = Math.max(a.length, b.length);
  if (max === 0) return 0;
  const lengthRatio = Math.abs(a.length - b.length) / max;
  let differing = 0;
  for (let i = 0; i < BUCKETS; i += 1) if (a.buckets[i] !== b.buckets[i]) differing += 1;
  return Math.min(1, Math.max(lengthRatio, differing / BUCKETS));
}

export function framesDiffer(a: FrameSignature, b: FrameSignature, threshold: number = DIFF_THRESHOLD): boolean {
  return signatureDifference(a, b) >= threshold;
}
