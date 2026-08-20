/**
 * Product-level artifact size policy for browser inference workers.
 *
 * The target is deliberately much smaller than the device VRAM ceiling: initial
 * download, persistent browser cache, WebGPU upload/compile, memory spikes, and
 * short visitor sessions all make large shards impractical even when they fit
 * in GPU memory.
 */

export const BROWSER_SEGMENT_TARGET_BYTES = 200 * 1024 * 1024;
export const BROWSER_SEGMENT_PREFERRED_MAX_BYTES = 256 * 1024 * 1024;
export const BROWSER_SEGMENT_NORMAL_MAX_BYTES = 512 * 1024 * 1024;
export const BROWSER_SEGMENT_ABSOLUTE_MAX_BYTES = 1024 * 1024 * 1024;

export type BrowserSegmentArtifactTier = 'preferred' | 'normal' | 'degraded' | 'rejected';

export interface BrowserSegmentArtifactBudgetResult {
  readonly byteSize: number;
  readonly tier: BrowserSegmentArtifactTier;
  readonly targetBytes: number;
  readonly preferredMaxBytes: number;
  readonly normalMaxBytes: number;
  readonly absoluteMaxBytes: number;
  readonly usable: boolean;
}

export function evaluateBrowserSegmentArtifactBytes(
  byteSize: number,
): BrowserSegmentArtifactBudgetResult {
  if (!Number.isSafeInteger(byteSize) || byteSize < 0) {
    throw new Error(`segment artifact byte size must be a non-negative safe integer: ${byteSize}`);
  }

  let tier: BrowserSegmentArtifactTier;
  if (byteSize <= BROWSER_SEGMENT_PREFERRED_MAX_BYTES) {
    tier = 'preferred';
  } else if (byteSize <= BROWSER_SEGMENT_NORMAL_MAX_BYTES) {
    tier = 'normal';
  } else if (byteSize <= BROWSER_SEGMENT_ABSOLUTE_MAX_BYTES) {
    tier = 'degraded';
  } else {
    tier = 'rejected';
  }

  return {
    byteSize,
    tier,
    targetBytes: BROWSER_SEGMENT_TARGET_BYTES,
    preferredMaxBytes: BROWSER_SEGMENT_PREFERRED_MAX_BYTES,
    normalMaxBytes: BROWSER_SEGMENT_NORMAL_MAX_BYTES,
    absoluteMaxBytes: BROWSER_SEGMENT_ABSOLUTE_MAX_BYTES,
    usable: tier !== 'rejected',
  };
}
