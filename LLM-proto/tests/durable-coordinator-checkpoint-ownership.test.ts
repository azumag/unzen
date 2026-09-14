import { describe, expect, it } from 'vitest';
import { createCheckpointEnvelope } from '../src/checkpoint-envelope.js';
import {
  DurableCoordinator,
  type DurableSegmentExecutor,
} from '../src/durable-coordinator.js';
import { InMemoryRepository } from '../src/durable-repository.js';
import {
  generateAttemptId,
  generateLeaseId,
  generateRequestId,
} from '../src/ids.js';
import { createFixtureModelManifest } from '../src/model-manifest-fixtures.js';
import type { SegmentedModelManifest } from '../src/model-manifest.js';
import { WorkerTier, workerId } from '../src/types.js';
import type { ResultIdentity } from '../src/durable-types.js';

const executor: DurableSegmentExecutor = {
  execute: async () => {
    throw new Error('not used by checkpoint ownership tests');
  },
};

interface Fixture {
  readonly repo: InMemoryRepository;
  readonly coord: DurableCoordinator;
  readonly manifest: SegmentedModelManifest;
  readonly identity: ResultIdentity;
}

function fixture(): Fixture {
  const manifest = createFixtureModelManifest({ totalSegments: 2 });
  const repo = new InMemoryRepository();
  const coord = new DurableCoordinator(
    executor,
    manifest,
    { allowFixtureManifest: true, maxRetries: 0, retryDelayMs: 0 },
    repo,
  );
  const worker = workerId('checkpoint-ownership-worker');
  const registration = coord.registerWorker(
    { workerId: worker, tier: WorkerTier.TIER_3, vramMB: 8_192 },
    'checkpoint-ownership-connection',
  );
  const requestId = generateRequestId();
  const attemptId = generateAttemptId();
  const leaseId = generateLeaseId();
  const now = Date.now();

  repo.createRequest({
    requestId,
    prompt: 'checkpoint ownership',
    stage: 'accepted',
    createdAt: now,
    currentSegment: 0,
    totalSegments: 2,
    manifestDigest: coord.manifestDigest,
    retryCount: 0,
  });
  repo.transitionStage(requestId, 'accepted', 'queued');
  repo.transitionStage(requestId, 'queued', 'leased');
  repo.transitionStage(requestId, 'leased', 'running');
  repo.appendAttempt(requestId, {
    requestId,
    attemptId,
    leaseId,
    workerId: worker,
    workerGeneration: registration.generation,
    segmentIndex: 0,
    startedAt: now,
  });
  repo.putLease({
    requestId,
    attemptId,
    leaseId,
    workerId: worker,
    workerGeneration: registration.generation,
    segmentIndex: 0,
    modelManifestDigest: coord.manifestDigest,
    issuedAt: now,
    expiresAt: now + 60_000,
  });

  return {
    repo,
    coord,
    manifest,
    identity: {
      requestId,
      attemptId,
      leaseId,
      workerId: worker,
      workerGeneration: registration.generation,
      segmentIndex: 0,
    },
  };
}

describe('DurableCoordinator checkpoint ownership', () => {
  it('captures declared metadata once, avoids enumeration, and copies payload before async validation', async () => {
    const f = fixture();
    const callerPayload = new Uint8Array([7, 8, 9, 10]);
    const base = await createCheckpointEnvelope({
      requestId: f.identity.requestId,
      attemptId: f.identity.attemptId,
      segmentIndex: 0,
      workerId: f.identity.workerId,
      workerGeneration: f.identity.workerGeneration,
      modelManifestDigest: f.manifest.manifestDigest,
      formatVersion: f.manifest.checkpointFormat,
      payload: callerPayload,
      ttlMs: 60_000,
      createdAt: Date.now(),
    });

    let unknownReads = 0;
    let ownKeysReads = 0;
    const target: Record<PropertyKey, unknown> = { ...base };
    Object.defineProperty(target, 'unrelated', {
      enumerable: true,
      configurable: true,
      get() {
        unknownReads += 1;
        throw new Error('unrelated checkpoint getter must not run');
      },
    });

    const reads: Record<string, number> = {};
    const declared = new Set([
      'payload',
      'requestId',
      'attemptId',
      'workerId',
      'workerGeneration',
      'formatVersion',
      'segmentIndex',
      'payloadLength',
      'modelManifestDigest',
      'payloadDigest',
      'createdAt',
      'ttlMs',
      'previousCheckpointDigest',
    ]);
    const checkpoint = new Proxy(target, {
      ownKeys() {
        ownKeysReads += 1;
        throw new Error('caller checkpoint ownKeys must not run');
      },
      get(object, property, receiver) {
        if (typeof property === 'string' && declared.has(property)) {
          reads[property] = (reads[property] ?? 0) + 1;
          if (reads[property] > 1) {
            if (property === 'payload') return new Uint8Array([99]);
            if (property === 'segmentIndex') return 999;
            return 'drifted';
          }
        }
        return Reflect.get(object, property, receiver);
      },
    });

    let checkpointRootReads = 0;
    const acceptancePromise = f.coord.handleWorkerResult({
      identity: f.identity,
      processingTimeMs: 2,
      get checkpoint() {
        checkpointRootReads += 1;
        return checkpoint as never;
      },
    });

    // The public boundary copies the payload synchronously before checkpoint
    // digest validation yields. Mutating executor-owned bytes afterwards must
    // not change the accepted/persisted checkpoint.
    callerPayload.fill(255);

    const acceptance = await acceptancePromise;
    expect(acceptance.kind).toBe('accepted');
    if (acceptance.kind !== 'accepted' || acceptance.isFinal) {
      throw new Error('expected an accepted intermediate checkpoint');
    }
    expect([...acceptance.checkpoint!.payload]).toEqual([7, 8, 9, 10]);
    const stored = f.repo.getCheckpoint(f.identity.requestId, 0);
    expect(stored).toBeDefined();
    expect([...stored!.payload]).toEqual([7, 8, 9, 10]);

    expect(checkpointRootReads).toBe(1);
    expect(ownKeysReads).toBe(0);
    expect(unknownReads).toBe(0);
    for (const field of declared) {
      expect(reads[field], field).toBe(1);
    }
  });

  it('preserves the payload-first fail-fast gate without touching metadata', async () => {
    const f = fixture();
    let payloadReads = 0;
    let requestIdReads = 0;
    let unrelatedReads = 0;
    const checkpoint = {
      get payload() {
        payloadReads += 1;
        return Symbol('not-bytes');
      },
      get requestId() {
        requestIdReads += 1;
        throw new Error('requestId must not be read after malformed payload');
      },
      get unrelated() {
        unrelatedReads += 1;
        throw new Error('unknown getter must not be read');
      },
    };

    await expect(f.coord.handleWorkerResult({
      identity: f.identity,
      processingTimeMs: 1,
      checkpoint: checkpoint as never,
    })).resolves.toEqual({
      kind: 'checkpoint-rejected',
      message: 'checkpoint payload must be a Uint8Array',
    });
    expect(payloadReads).toBe(1);
    expect(requestIdReads).toBe(0);
    expect(unrelatedReads).toBe(0);
    expect(f.repo.getCheckpoint(f.identity.requestId, 0)).toBeUndefined();
  });
});
