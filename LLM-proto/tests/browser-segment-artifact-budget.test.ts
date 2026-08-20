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

  it('rejects invalid byte sizes', () => {
    expect(() => evaluateBrowserSegmentArtifactBytes(-1)).toThrow(/non-negative safe integer/);
    expect(() => evaluateBrowserSegmentArtifactBytes(Number.MAX_VALUE)).toThrow(/non-negative safe integer/);
  });
});
