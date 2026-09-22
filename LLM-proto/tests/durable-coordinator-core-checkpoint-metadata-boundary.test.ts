import { describe, expect, it, vi } from 'vitest';
import { DurableCoordinator as DurableCoordinatorCore } from '../src/durable-coordinator-core.js';
import type { DurableSegmentExecutor } from '../src/durable-coordinator-core.js';
import { InMemoryRepository } from '../src/durable-repository.js';
import { createCheckpointEnvelope, type CheckpointEnvelope } from '../src/checkpoint-envelope.js';
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
    throw new Error('not used by direct-core checkpoint metadata tests');
  },
};

const metadataFields = [
  'requestId',
  'attemptId',
  'workerId',
  'workerGeneration',
  'formatVersion',
  'segmentIndex',
  'payloadLength',
  'modelManifestDigest',
  'payloadDigest',
  'previousCheckpointDigest',
  'createdAt',
  'ttlMs',
] as const;

async function fixture(maxCheckpointBytes = 64) {
  const repo = new InMemoryRepository();
  const manifest = createFixtureModelManifest({ totalSegments: 2 });
  const coord = new DurableCoordinatorCore(
    executor,
    manifest,
    { allowFixtureManifest: true, maxCheckpointBytes },
    repo,
  );
  const requestId = generateRequestId();
  const identity: ResultIdentity = {
    requestId,
    attemptId: generateAttemptId(),
    leaseId: generateLeaseId(),
    workerId: workerId('direct-core-checkpoint-metadata-worker'),
    workerGeneration: generateWorkerGeneration(),
    segmentIndex: 0,
  };
  const createdAt = Date.now();
  repo.createRequest({
    requestId,
    prompt: 'checkpoint metadata boundary',
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
    segmentIndex: 0,
    workerId: identity.workerId,
    workerGeneration: identity.workerGeneration,
    modelManifestDigest: manifest.manifestDigest,
    formatVersion: manifest.checkpointFormat,
    payload: new Uint8Array([1, 2, 3]),
    ttlMs: 60_000,
    createdAt,
  });
  const result: ExecutionResult = { identity, checkpoint, processingTimeMs: 1 };
  return { coord, repo, requestId, createdAt, checkpoint, result };
}

function hostileThrownValue() {
  return {
    toString: vi.fn(() => {
      throw new Error('hostile thrown value must not be stringified');
    }),
    [Symbol.toPrimitive]: vi.fn(() => {
      throw new Error('hostile thrown value must not be coerced');
    }),
  };
}

function withCheckpoint(result: ExecutionResult, checkpoint: CheckpointEnvelope): ExecutionResult {
  return { ...result, checkpoint };
}

describe('direct durable-core checkpoint metadata runtime boundary', () => {
  it('accepts a valid checkpoint without invoking caller ownKeys', async () => {
    const f = await fixture();
    let ownKeysCalls = 0;
    const checkpoint = new Proxy(f.checkpoint, {
      ownKeys() {
        ownKeysCalls += 1;
        throw new Error('caller checkpoint ownKeys must not run');
      },
    });

    await expect(
      f.coord.acceptResult(withCheckpoint(f.result, checkpoint), f.createdAt),
    ).resolves.toMatchObject({ kind: 'accepted', isFinal: false });

    expect(ownKeysCalls).toBe(0);
    expect(f.repo.getCheckpoint(f.requestId, 0)).toBeDefined();
  });

  it('rejects a throwing metadata descriptor trap without touching later source metadata', async () => {
    const f = await fixture();
    const thrown = hostileThrownValue();
    const inspected: PropertyKey[] = [];
    const checkpoint = new Proxy(f.checkpoint, {
      getOwnPropertyDescriptor(target, property) {
        inspected.push(property);
        if (property === 'requestId') throw thrown;
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });

    await expect(
      f.coord.acceptResult(withCheckpoint(f.result, checkpoint), f.createdAt),
    ).resolves.toEqual({
      kind: 'checkpoint-rejected',
      message: 'checkpoint requestId must be a non-empty string',
    });

    expect(inspected).toEqual(['requestId']);
    expect(thrown.toString).not.toHaveBeenCalled();
    expect(thrown[Symbol.toPrimitive]).not.toHaveBeenCalled();
    expect(f.repo.getCheckpoint(f.requestId, 0)).toBeUndefined();
  });

  it('rejects a throwing required metadata getter once and skips later getters', async () => {
    const f = await fixture();
    const thrown = hostileThrownValue();
    const checkpoint = { ...f.checkpoint } as CheckpointEnvelope;
    let requestReads = 0;
    let attemptReads = 0;
    Object.defineProperty(checkpoint, 'requestId', {
      configurable: true,
      enumerable: true,
      get() {
        requestReads += 1;
        throw thrown;
      },
    });
    Object.defineProperty(checkpoint, 'attemptId', {
      configurable: true,
      enumerable: true,
      get() {
        attemptReads += 1;
        return f.checkpoint.attemptId;
      },
    });

    await expect(
      f.coord.acceptResult(withCheckpoint(f.result, checkpoint), f.createdAt),
    ).resolves.toEqual({
      kind: 'checkpoint-rejected',
      message: 'checkpoint requestId must be a non-empty string',
    });

    expect(requestReads).toBe(1);
    expect(attemptReads).toBe(0);
    expect(thrown.toString).not.toHaveBeenCalled();
    expect(thrown[Symbol.toPrimitive]).not.toHaveBeenCalled();
  });

  it('keeps an inaccessible optional previousCheckpointDigest present and invalid', async () => {
    const f = await fixture();
    const thrown = hostileThrownValue();
    const checkpoint = { ...f.checkpoint } as CheckpointEnvelope;
    let reads = 0;
    Object.defineProperty(checkpoint, 'previousCheckpointDigest', {
      configurable: true,
      enumerable: true,
      get() {
        reads += 1;
        throw thrown;
      },
    });

    await expect(
      f.coord.acceptResult(withCheckpoint(f.result, checkpoint), f.createdAt),
    ).resolves.toEqual({
      kind: 'checkpoint-rejected',
      message: 'checkpoint previousCheckpointDigest must be canonical lowercase SHA-256 when present',
    });

    expect(reads).toBe(1);
    expect(thrown.toString).not.toHaveBeenCalled();
    expect(thrown[Symbol.toPrimitive]).not.toHaveBeenCalled();
  });

  it('keeps an inaccessible optional descriptor present and invalid', async () => {
    const f = await fixture();
    const thrown = hostileThrownValue();
    const checkpoint = new Proxy(f.checkpoint, {
      getOwnPropertyDescriptor(target, property) {
        if (property === 'previousCheckpointDigest') throw thrown;
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });

    await expect(
      f.coord.acceptResult(withCheckpoint(f.result, checkpoint), f.createdAt),
    ).resolves.toEqual({
      kind: 'checkpoint-rejected',
      message: 'checkpoint previousCheckpointDigest must be canonical lowercase SHA-256 when present',
    });

    expect(thrown.toString).not.toHaveBeenCalled();
    expect(thrown[Symbol.toPrimitive]).not.toHaveBeenCalled();
  });

  it('reads each reached declared metadata getter at most once', async () => {
    const f = await fixture();
    const checkpoint = { ...f.checkpoint } as CheckpointEnvelope;
    const reads = new Map<string, number>();
    for (const field of metadataFields) {
      const value = f.checkpoint[field];
      Object.defineProperty(checkpoint, field, {
        configurable: true,
        enumerable: true,
        get() {
          reads.set(field, (reads.get(field) ?? 0) + 1);
          return value;
        },
      });
    }

    await expect(
      f.coord.acceptResult(withCheckpoint(f.result, checkpoint), f.createdAt),
    ).resolves.toMatchObject({ kind: 'accepted', isFinal: false });

    for (const field of metadataFields) {
      expect(reads.get(field), field).toBe(1);
    }
  });

  it('rejects an oversized payload before descriptor or key-enumeration metadata work', async () => {
    const f = await fixture(2);
    let ownKeysCalls = 0;
    let descriptorCalls = 0;
    const checkpoint = new Proxy(f.checkpoint, {
      ownKeys() {
        ownKeysCalls += 1;
        throw new Error('oversized payload must reject before caller ownKeys');
      },
      getOwnPropertyDescriptor() {
        descriptorCalls += 1;
        throw new Error('oversized payload must reject before metadata descriptors');
      },
    });

    await expect(
      f.coord.acceptResult(withCheckpoint(f.result, checkpoint), f.createdAt),
    ).resolves.toEqual({
      kind: 'checkpoint-rejected',
      message: 'checkpoint payload 3B exceeds the 2B limit',
    });

    expect(ownKeysCalls).toBe(0);
    expect(descriptorCalls).toBe(0);
    expect(f.repo.getCheckpoint(f.requestId, 0)).toBeUndefined();
  });
});
