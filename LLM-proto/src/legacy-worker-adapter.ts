/**
 * Temporary adapter for the OLD Worker registration protocol (issue #94
 * deliverable 9).
 *
 * Legacy segmented workers register with `WorkerRegistration`
 * (`{ workerId, tier, vramMB }`, see `protocol.ts`) and are driven through
 * `SegmentExecutor`. The new capability routing must still see them as
 * candidates without changing the existing segmented route behavior.
 *
 * This adapter converts a legacy registration into a `WorkerCapability` so the
 * same capability-based routing treats legacy and new backends uniformly.
 * Important: the legacy protocol does not report context window, health, or
 * latency, so the adapter fills those with clearly-labeled ESTIMATES derived
 * from the tier/VRAM fields. It never fabricates segment geometry (no layer
 * ranges, no weight hashes) — those remain the model manifest's job.
 *
 * This adapter is temporary: once every segmented worker speaks the
 * `InferenceBackend` contract, legacy registrations should migrate and this
 * module can be deleted.
 */
import { WorkerTier } from './types.js';
import type { WorkerRegistration } from './protocol.js';
import {
  CAPABILITY_SCHEMA_VERSION,
  type WorkerCapability,
} from './inference-backend.js';

/**
 * Estimated per-token context budget (tokens) derived from the reported VRAM.
 * Legacy registrations carry no context-window figure, so this is a
 * placeholder estimate, not a runtime report.
 */
function estimateContextWindowTokens(vramMB: number): number {
  return Math.max(1, Math.floor(vramMB / 4));
}

/**
 * Estimated single-request latency by tier (ms). Tier 1 devices are the most
 * stable and fastest in the plan (PLAN.md 4.5.4); the values are ordering
 * placeholders for candidate ranking, not measurements.
 */
function estimateExpectedLatencyMs(tier: WorkerTier): number {
  switch (tier) {
    case WorkerTier.TIER_1:
      return 50;
    case WorkerTier.TIER_2:
      return 200;
    case WorkerTier.TIER_3:
      return 1_000;
  }
}

/**
 * Build the capability a legacy segmented worker exposes to capability-based
 * routing. All derived numbers are documented estimates because the legacy
 * protocol does not report them.
 */
export function legacyRegistrationToCapability(
  registration: WorkerRegistration,
): WorkerCapability {
  return {
    schemaVersion: CAPABILITY_SCHEMA_VERSION,
    backend: 'segmented-webgpu',
    runtimeName: 'legacy-segment-executor',
    runtimeVersion: '0.0.0',
    executionMode: 'segment',
    inputModalities: ['text'],
    outputModalities: ['text'],
    supportedLanguages: ['ja', 'en'],
    streaming: false,
    contextWindowTokens: estimateContextWindowTokens(registration.vramMB),
    requiresUserActivation: false,
    executionSurfaces: ['worker'],
    supportsCancellation: true,
    maxConcurrency: 1,
    expectedLatencyMs: estimateExpectedLatencyMs(registration.tier),
    // The legacy protocol reports no failure history; start at zero (no
    // observed failures yet) rather than assuming the worker is unhealthy.
    health: { recentFailureRate: 0 },
    privacyBoundary: 'in-browser',
    allowedNetworkDestinations: ['coordinator', 'cdn'],
  };
}
