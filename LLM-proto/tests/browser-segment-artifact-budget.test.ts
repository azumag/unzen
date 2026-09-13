import { describe, expect, it } from 'vitest';
import {
  BROWSER_SEGMENT_ABSOLUTE_MAX_BYTES,
  BROWSER_SEGMENT_NORMAL_MAX_BYTES,
  BROWSER_SEGMENT_PREFERRED_MAX_BYTES,
  BROWSER_SEGMENT_TARGET_BYTES,
  evaluateBrowserSegmentArtifactBytes,
} from '../src/browser-segment-artifact-budget.js';

describe('browser segment artifact budget', () => {
  it('targets roughly 200 MiB and prefers shards no larger than 256 MiB', () => {
    expect(BROWSER_SEGMENT_TARGET_BYTES).toBe(200 * 1024 * 1024);
    expect(BROWSER_SEGMENT_PREFERRED_MAX_BYTES).toBe(256 * 1024 * 1024);
    expect(evaluateBrowserSegmentArtifactBytes(BROWSER_SEGMENT_TARGET_BYTES).tier).toBe('preferred');
  });

  it('classifies larger shards without treating the 1 GiB hard limit as a normal target', () => {
    expect(evaluateBrowserSegmentArtifactBytes(BROWSER_SEGMENT_PREFERRED_MAX_BYTES + 1).tier).toBe('normal');
    expect(evaluateBrowserSegmentArtifactBytes(BROWSER_SEGMENT_NORMAL_MAX_BYTES + 1).tier).toBe('degraded');
    expect(evaluateBrowserSegmentArtifactBytes(BROWSER_SEGMENT_ABSOLUTE_MAX_BYTES + 1)).toMatchObject({
      tier: 'rejected',
      usable: false,
    });
  });

  it('returns a frozen policy snapshot that cast-based mutation cannot rewrite', () => {
    const result = evaluateBrowserSegmentArtifactBytes(BROWSER_SEGMENT_TARGET_BYTES);
    expect(Object.isFrozen(result)).toBe(true);

    const attemptedMutations = {
      byteSize: 1,
      tier: 'rejected',
      targetBytes: 1,
      preferredMaxBytes: 1,
      normalMaxBytes: 1,
      absoluteMaxBytes: 1,
      usable: false,
    } as const;
    for (const [key, value] of Object.entries(attemptedMutations)) {
      expect(Reflect.set(result as object, key, value)).toBe(false);
    }

    expect(result).toEqual({
      byteSize: BROWSER_SEGMENT_TARGET_BYTES,
      tier: 'preferred',
      targetBytes: BROWSER_SEGMENT_TARGET_BYTES,
      preferredMaxBytes: BROWSER_SEGMENT_PREFERRED_MAX_BYTES,
      normalMaxBytes: BROWSER_SEGMENT_NORMAL_MAX_BYTES,
      absoluteMaxBytes: BROWSER_SEGMENT_ABSOLUTE_MAX_BYTES,
      usable: true,
    });
  });

  it('rejects structurally impossible or unsafe byte sizes before tier classification', () => {
    for (const byteSize of [
      0,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(() => evaluateBrowserSegmentArtifactBytes(byteSize)).toThrow(/positive safe integer/);
    }
  });

  it.each([
    null,
    undefined,
    '1',
    true,
    {},
    [],
    Symbol('bytes'),
  ])('rejects asserted non-number runtime byte size %p without coercion errors', (byteSize) => {
    expect(() => evaluateBrowserSegmentArtifactBytes(byteSize as never)).toThrow(
      'segment artifact byte size must be a positive safe integer',
    );
  });
});
