import { describe, expect, it } from 'vitest';
import { DIFF_THRESHOLD, frameSignature, framesDiffer, signatureDifference } from '../../bridge/src/vision/diff.js';
import { noise } from './helpers.js';

describe('frame difference heuristic', () => {
  it('is 0 for identical frames and 1 for unrelated ones', () => {
    const a = noise(120_000, 1);
    expect(signatureDifference(frameSignature(a), frameSignature(a))).toBe(0);
    expect(signatureDifference(frameSignature(a), frameSignature(noise(120_000, 2)))).toBeGreaterThan(0.95);
    expect(framesDiffer(frameSignature(a), frameSignature(a))).toBe(false);
    expect(framesDiffer(frameSignature(a), frameSignature(noise(120_000, 3)))).toBe(true);
  });

  it('counts a length change as at least its proportion', () => {
    const a = noise(100_000, 7);
    const b = a.slice(0, 90_000);
    expect(signatureDifference(frameSignature(a), frameSignature(b))).toBeGreaterThanOrEqual(0.1);
    expect(signatureDifference(frameSignature(''), frameSignature(''))).toBe(0);
    expect(signatureDifference(frameSignature(''), frameSignature('AAAA'))).toBe(1);
  });

  it('is symmetric, bounded and cheap on large frames', () => {
    const a = frameSignature(noise(400_000, 11));
    const b = frameSignature(noise(400_000, 12));
    const ab = signatureDifference(a, b);
    expect(ab).toBe(signatureDifference(b, a));
    expect(ab).toBeLessThanOrEqual(1);
    expect(a.buckets.length).toBe(128);
  });

  it('treats a change confined to the tail of the byte stream as "unchanged" (documented approximation)', () => {
    const a = noise(120_000, 21);
    const tail = a.slice(0, a.length - 200) + noise(200, 22);
    const diff = signatureDifference(frameSignature(a), frameSignature(tail));
    expect(diff).toBeGreaterThan(0);
    expect(diff).toBeLessThan(DIFF_THRESHOLD);
    // A change a few percent from the end lands in more than one bucket and is seen as a change.
    const mid = a.slice(0, 110_000) + noise(10_000, 23);
    expect(signatureDifference(frameSignature(a), frameSignature(mid))).toBeGreaterThanOrEqual(DIFF_THRESHOLD);
  });
});
