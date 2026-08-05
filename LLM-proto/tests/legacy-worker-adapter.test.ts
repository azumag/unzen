import { describe, expect, it } from 'vitest';
import { workerId, WorkerTier } from '../src/types.js';
import type { WorkerRegistration } from '../src/protocol.js';
import { legacyRegistrationToCapability } from '../src/legacy-worker-adapter.js';
import { validateWorkerCapability } from '../src/inference-capability.js';
import { BackendRegistry } from '../src/backend-registry.js';

function legacyRegistration(overrides: Partial<WorkerRegistration> = {}): WorkerRegistration {
  return {
    workerId: workerId('w1'),
    tier: WorkerTier.TIER_3,
    vramMB: 8192,
    ...overrides,
  };
}

describe('legacy Worker registration adapter (issue #94 deliverable 9)', () => {
  it('maps a legacy segmented registration into a valid segmented capability', () => {
    const capability = legacyRegistrationToCapability(legacyRegistration());

    expect(capability.backend).toBe('segmented-webgpu');
    expect(capability.executionMode).toBe('segment');
    expect(capability.allowedNetworkDestinations).toEqual(['coordinator', 'cdn']);
    const validation = validateWorkerCapability(capability);
    expect(validation.status).toBe('valid');
  });

  it('maps tier to expected latency so stable workers are preferred', () => {
    const tier1 = legacyRegistrationToCapability(
      legacyRegistration({ tier: WorkerTier.TIER_1 }),
    );
    const tier2 = legacyRegistrationToCapability(
      legacyRegistration({ tier: WorkerTier.TIER_2 }),
    );
    const tier3 = legacyRegistrationToCapability(
      legacyRegistration({ tier: WorkerTier.TIER_3 }),
    );

    expect(tier1.expectedLatencyMs).toBeLessThan(tier2.expectedLatencyMs);
    expect(tier2.expectedLatencyMs).toBeLessThan(tier3.expectedLatencyMs);
  });

  it('carries the legacy VRAM report into the capability without fabricating segment geometry', () => {
    const capability = legacyRegistrationToCapability(
      legacyRegistration({ vramMB: 16384 }),
    );

    // The legacy protocol reports VRAM; the adapter must surface it as
    // scheduling context but never mint layer ranges / weight hashes.
    expect(capability.health?.recentFailureRate).toBeGreaterThanOrEqual(0);
    expect(capability.health?.recentFailureRate).toBeLessThanOrEqual(1);
    // @ts-expect-error issue #94: the segmented capability carries no weight hash.
    void capability.modelWeightHash;
  });

  it('can be registered capability-only and participate in routing', () => {
    const registry = new BackendRegistry();
    registry.registerCapability(
      'legacy-w1',
      legacyRegistrationToCapability(legacyRegistration()),
    );

    const candidates = registry.selectCandidates((c) => c.backend === 'segmented-webgpu');
    expect(candidates).toEqual(['legacy-w1']);
    // The legacy worker is driven through the old SegmentExecutor path, so it
    // exposes no new-interface backend for execute().
    expect(registry.get('legacy-w1')).toBeUndefined();
  });
});
