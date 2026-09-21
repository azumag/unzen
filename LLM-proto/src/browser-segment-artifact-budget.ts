/**
 * Product-level artifact size policy for browser inference workers.
 *
 * The target is deliberately much smaller than the device VRAM ceiling: initial
 * download, persistent browser cache, WebGPU upload/compile, memory spikes, and
 * short visitor sessions all make large shards impractical even when they fit
 * in GPU memory.
 *
 * This evaluator is also a structural fail-closed boundary. A segment artifact
 * must contain at least one byte; callers must not treat an impossible empty
 * artifact as a preferred/usable browser cache unit merely because it is under
 * the configured size ceilings. Runtime callers are not trusted to preserve
 * the TypeScript `number` annotation, so validation must not coerce or format
 * an unvalidated value before its type has been established.
 */

import type { SegmentArtifact } from './model-manifest.js';

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

/**
 * Evaluate the byte-size field of a runtime segment artifact through the same
 * product policy as raw measured byte counts.
 *
 * The object boundary matters even though callers normally hold a typed
 * `SegmentArtifact`: decoded/asserted values and accessor-backed objects can
 * cross JavaScript boundaries. Capture `byteSize` exactly once before
 * delegating so validation and classification cannot observe different reads.
 */
export function evaluateBrowserSegmentArtifact(
  artifact: Pick<SegmentArtifact, 'byteSize'>,
): BrowserSegmentArtifactBudgetResult {
  if (typeof artifact !== 'object' || artifact === null) {
    throw new Error('segment artifact must be an object');
  }

  let isArray: boolean;
  try {
    isArray = Array.isArray(artifact);
  } catch {
    throw new Error('segment artifact must be an object');
  }
  if (isArray) {
    throw new Error('segment artifact must be an object');
  }

  let byteSize: unknown;
  try {
    byteSize = (artifact as { readonly byteSize?: unknown }).byteSize;
  } catch {
    throw new Error('segment artifact byte size must be a positive safe integer');
  }
  return evaluateBrowserSegmentArtifactBytes(byteSize as number);
}

export function evaluateBrowserSegmentArtifactBytes(
  byteSize: number,
): BrowserSegmentArtifactBudgetResult {
  if (
    typeof byteSize !== 'number'
    || !Number.isSafeInteger(byteSize)
    || byteSize <= 0
  ) {
    throw new Error('segment artifact byte size must be a positive safe integer');
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

  return Object.freeze({
    byteSize,
    tier,
    targetBytes: BROWSER_SEGMENT_TARGET_BYTES,
    preferredMaxBytes: BROWSER_SEGMENT_PREFERRED_MAX_BYTES,
    normalMaxBytes: BROWSER_SEGMENT_NORMAL_MAX_BYTES,
    absoluteMaxBytes: BROWSER_SEGMENT_ABSOLUTE_MAX_BYTES,
    usable: tier !== 'rejected',
  });
}
