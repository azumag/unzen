import { afterEach, describe, expect, it, vi } from 'vitest';
import { DurableCoordinator, type DurableSegmentExecutor } from '../src/durable-coordinator.js';
import { DurableCoordinator as DurableCoordinatorCore } from '../src/durable-coordinator-core.js';
import { InMemoryRepository } from '../src/durable-repository.js';
import { createCheckpointEnvelope } from '../src/checkpoint-envelope.js';
import { createFixtureModelManifest } from '../src/model-manifest-fixtures.js';
import {
  generateAttemptId,
  generateLeaseId,
  generateRequestId,
  generateWorkerGeneration,
} from '../src/ids.js';
import { workerId } from '../src/types.js';
import type { ExecutionResult, Lease, ResultIdentity } from '../src/durable-types.js';

const executor: DurableSegmentExecutor = {
  execute: async () => {
    throw new Error('not used by pushed-result budget tests');
  },
};

async function fixture(usePublicBoundary: boolean) {
  const repo = new InMemoryRepository();
  const manifest = createFixtureModelManifest({ totalSegments: 2 });
  const options = { allowFixtureManifest: true, maxCheckpointBytes: 2 } as const;
  const coord = usePublicBoundary
    ? new DurableCoordinator(executor, manifest, options, repo)
    : new DurableCoordinatorCore(executor, manifest, options, repo);

  const requestId = generateRequestId();
  const identity: ResultIdentity = {
    requestId,
    attemptId: generateAttemptId(),
    leaseId: generateLeaseId(),
    workerId: workerId('worker-a'),
    workerGeneration: generateWorkerGeneration(),
    segmentIndex: 0,
  };
  const createdAt = Date.now();
  repo.createRequest({
    requestId,
    prompt: 'oversized-checkpoint',
    stage: 'accepted',
    createdAt,
    currentSegment: 0,
    totalSegments: 2,
    manifestDigest: manifest.manifestDigest,
    retryCount: 0,
  });
  repo.transitionStage(requestId, 'accepted', 'queued');
  repo.transitionStage(requestId, 'queued', 'leased');
  repo.transitionStage(requestId, 'leased', 'running');
  const lease: Lease = {
    ...identity,
    modelManifestDigest: manifest.manifestDigest,
    issuedAt: createdAt,
    expiresAt: createdAt + 60_000,
  };
  repo.putLease(lease);

  const checkpoint = await createCheckpointEnvelope({
    requestId,
    attemptId: identity.attemptId,
    segmentIndex: identity.segmentIndex,
    workerId: identity.workerId,
    workerGeneration: identity.workerGeneration,
    modelManifestDigest: manifest.manifestDigest,
    formatVersion: manifest.checkpointFormat,
    payload: new Uint8Array([1, 2, 3]),
    ttlMs: 60_000,
    createdAt,
  });
  const result: ExecutionResult = { identity, checkpoint, processingTimeMs: 1 };
  return { coord, repo, requestId, result, createdAt };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe.each([
  ['public DurableCoordinator boundary', true],
  ['direct durable core boundary', false],
] as const)('%s checkpoint pre-copy budget', (_name, usePublicBoundary) => {
  it('rejects an oversized payload before any Uint8Array ownership copy or digest', async () => {
    const f = await fixture(usePublicBoundary);
    const NativeUint8Array = globalThis.Uint8Array;
    let typedArrayCopies = 0;
    const TrackedUint8Array = new Proxy(NativeUint8Array, {
      construct(target, args, newTarget) {
        if (args[0] instanceof NativeUint8Array) typedArrayCopies += 1;
        return Reflect.construct(target, args, newTarget);
      },
    });
    vi.stubGlobal('Uint8Array', TrackedUint8Array);
    const digestSpy = vi.spyOn(globalThis.crypto.subtle, 'digest');

    await expect(f.coord.acceptResult(f.result, f.createdAt)).resolves.toEqual({
      kind: 'checkpoint-rejected',
      message: 'checkpoint payload 3B exceeds the 2B limit',
    });

    expect(typedArrayCopies).toBe(0);
    expect(digestSpy).not.toHaveBeenCalled();
    expect(f.repo.getCheckpoint(f.requestId, 0)).toBeUndefined();
  });
});
