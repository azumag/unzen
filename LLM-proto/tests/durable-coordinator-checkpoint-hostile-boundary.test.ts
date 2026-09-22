import { describe, expect, it } from 'vitest';
import { createCheckpointEnvelope, type CheckpointEnvelope } from '../src/checkpoint-envelope.js';
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
import type { ResultIdentity } from '../src/durable-types.js';
import { WorkerTier, workerId } from '../src/types.js';

const executor: DurableSegmentExecutor = {
  execute: async () => {
    throw new Error('not used by checkpoint hostile-boundary tests');
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
  const worker = workerId('checkpoint-hostile-boundary-worker');
  const registration = coord.registerWorker(
    { workerId: worker, tier: WorkerTier.TIER_3, vramMB: 8_192 },
    'checkpoint-hostile-boundary-connection',
  );
  const requestId = generateRequestId();
  const attemptId = generateAttemptId();
  const leaseId = generateLeaseId();
  const now = Date.now();

  repo.createRequest({
    requestId,
    prompt: 'checkpoint hostile boundary',
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

async function checkpoint(f: Fixture): Promise<CheckpointEnvelope> {
  return createCheckpointEnvelope({
    requestId: f.identity.requestId,
    attemptId: f.identity.attemptId,
    segmentIndex: 0,
    workerId: f.identity.workerId,
    workerGeneration: f.identity.workerGeneration,
    modelManifestDigest: f.manifest.manifestDigest,
    formatVersion: f.manifest.checkpointFormat,
    payload: new Uint8Array([1, 2, 3, 4]),
    ttlMs: 60_000,
    createdAt: Date.now(),
  });
}

function hostileThrownValue(): { readonly coercions: () => number; readonly value: object } {
  let coercions = 0;
  const value = {
    toString() {
      coercions += 1;
      throw new Error('caller toString must not run');
    },
    [Symbol.toPrimitive]() {
      coercions += 1;
      throw new Error('caller Symbol.toPrimitive must not run');
    },
  };
  return { coercions: () => coercions, value };
}

async function expectPayloadRejected(f: Fixture, candidate: unknown): Promise<void> {
  await expect(f.coord.handleWorkerResult({
    identity: f.identity,
    processingTimeMs: 1,
    checkpoint: candidate as never,
  })).resolves.toEqual({
    kind: 'checkpoint-rejected',
    message: 'checkpoint payload must be a Uint8Array',
  });
  expect(f.repo.getCheckpoint(f.identity.requestId, 0)).toBeUndefined();
}

describe('DurableCoordinator hostile checkpoint runtime boundary', () => {
  it('fails closed on a throwing payload getter before touching metadata', async () => {
    const f = fixture();
    const hostile = hostileThrownValue();
    let payloadReads = 0;
    let requestIdReads = 0;
    const candidate = {
      get payload() {
        payloadReads += 1;
        throw hostile.value;
      },
      get requestId() {
        requestIdReads += 1;
        throw new Error('metadata must stay behind the payload-first gate');
      },
    };

    await expectPayloadRejected(f, candidate);

    expect(payloadReads).toBe(1);
    expect(requestIdReads).toBe(0);
    expect(hostile.coercions()).toBe(0);
  });

  it('fails closed on a revoked checkpoint root proxy', async () => {
    const f = fixture();
    const revokedRoot = Proxy.revocable({ payload: new Uint8Array([1]) }, {});
    revokedRoot.revoke();
    await expectPayloadRejected(f, revokedRoot.proxy);
  });

  it('fails closed on revoked and live Proxy-wrapped Uint8Array payloads', async () => {
    const revokedFixture = fixture();
    const revokedPayload = Proxy.revocable(new Uint8Array([1, 2, 3]), {});
    revokedPayload.revoke();
    await expectPayloadRejected(revokedFixture, { payload: revokedPayload.proxy });

    // A live Proxy around a typed array passes `instanceof Uint8Array`, but it
    // has no typed-array internal slots. Reject it before the core reads
    // `.byteLength`, which would otherwise throw a native TypeError.
    const liveFixture = fixture();
    const livePayload = new Proxy(new Uint8Array([1, 2, 3]), {});
    await expectPayloadRejected(liveFixture, { payload: livePayload });
  });

  it('normalizes a genuine Uint8Array subclass without invoking hostile byte-view accessors', async () => {
    const f = fixture();
    const base = await checkpoint(f);
    let byteViewReads = 0;
    class HostileByteView extends Uint8Array {}
    const payload = new HostileByteView([1, 2, 3, 4]);
    for (const field of ['byteLength', 'byteOffset', 'buffer'] as const) {
      Object.defineProperty(payload, field, {
        configurable: true,
        get() {
          byteViewReads += 1;
          throw new Error(`caller ${field} getter must not run`);
        },
      });
    }

    const acceptance = await f.coord.handleWorkerResult({
      identity: f.identity,
      processingTimeMs: 1,
      checkpoint: { ...base, payload },
    });

    expect(acceptance.kind).toBe('accepted');
    if (acceptance.kind !== 'accepted' || acceptance.isFinal) {
      throw new Error('expected an accepted intermediate checkpoint');
    }
    expect([...acceptance.checkpoint!.payload]).toEqual([1, 2, 3, 4]);
    expect(byteViewReads).toBe(0);
  });

  it('fails closed when a declared metadata descriptor cannot be inspected without enumerating', async () => {
    const f = fixture();
    const base = await checkpoint(f);
    let ownKeysReads = 0;
    const hostile = hostileThrownValue();
    const candidate = new Proxy({ ...base }, {
      ownKeys() {
        ownKeysReads += 1;
        throw new Error('ownKeys must not run');
      },
      getOwnPropertyDescriptor(target, property) {
        if (property === 'requestId') throw hostile.value;
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });

    await expect(f.coord.handleWorkerResult({
      identity: f.identity,
      processingTimeMs: 1,
      checkpoint: candidate as never,
    })).resolves.toEqual({
      kind: 'checkpoint-rejected',
      message: 'checkpoint requestId must be a non-empty string',
    });

    expect(ownKeysReads).toBe(0);
    expect(hostile.coercions()).toBe(0);
    expect(f.repo.getCheckpoint(f.identity.requestId, 0)).toBeUndefined();
  });

  it('rejects an inaccessible optional previousCheckpointDigest instead of treating it as absent', async () => {
    const f = fixture();
    const base = await checkpoint(f);
    const hostile = hostileThrownValue();
    let reads = 0;
    const candidate: Record<string, unknown> = { ...base };
    Object.defineProperty(candidate, 'previousCheckpointDigest', {
      enumerable: true,
      configurable: true,
      get() {
        reads += 1;
        throw hostile.value;
      },
    });

    await expect(f.coord.handleWorkerResult({
      identity: f.identity,
      processingTimeMs: 1,
      checkpoint: candidate as never,
    })).resolves.toEqual({
      kind: 'checkpoint-rejected',
      message: 'checkpoint previousCheckpointDigest must be canonical lowercase SHA-256 when present',
    });

    expect(reads).toBe(1);
    expect(hostile.coercions()).toBe(0);
    expect(f.repo.getCheckpoint(f.identity.requestId, 0)).toBeUndefined();
  });
});
