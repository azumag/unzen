import { afterEach, describe, expect, it, vi } from 'vitest';
import { DurableCoordinator, type DurableSegmentExecutor } from '../src/durable-coordinator.js';
import { InMemoryRepository, type DurableRepository } from '../src/durable-repository.js';
import {
  DurableObjectRepository,
  type DurableObjectSyncKvStorage,
} from '../src/durable-object-repository.js';
import { createFixtureModelManifest } from '../src/model-manifest-fixtures.js';
import { createCheckpointEnvelope } from '../src/checkpoint-envelope.js';
import {
  generateAttemptId,
  generateLeaseId,
  generateRequestId,
  generateWorkerGeneration,
} from '../src/ids.js';
import { workerId } from '../src/types.js';
import type { ExecutionResult, Lease, ResultIdentity } from '../src/durable-types.js';

class CloneOnAccessKv implements DurableObjectSyncKvStorage {
  private readonly values = new Map<string, unknown>();

  get<T = unknown>(key: string): T | undefined {
    const value = this.values.get(key);
    return value === undefined ? undefined : structuredClone(value) as T;
  }

  put<T = unknown>(key: string, value: T): void {
    this.values.set(key, structuredClone(value));
  }

  delete(key: string): boolean {
    return this.values.delete(key);
  }

  list<T = unknown>(options: { readonly prefix?: string } = {}): Iterable<[string, T]> {
    return [...this.values.entries()]
      .filter(([key]) => options.prefix === undefined || key.startsWith(options.prefix))
      .map(([key, value]) => [key, structuredClone(value) as T]);
  }
}

const executor: DurableSegmentExecutor = {
  execute: async () => {
    throw new Error('not used by pushed-result race tests');
  },
};

function deferredDigest() {
  const original = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
  let release!: () => void;
  let startedResolve!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { startedResolve = resolve; });
  const spy = vi.spyOn(globalThis.crypto.subtle, 'digest').mockImplementation((
    ((algorithm: AlgorithmIdentifier, data: BufferSource) => {
      startedResolve();
      return gate.then(() => original(algorithm, data));
    }) as SubtleCrypto['digest']
  ));
  return { started, release, restore: () => spy.mockRestore() };
}

async function fixture(repo: DurableRepository, leaseExpiresAt = Date.now() + 60_000) {
  const manifest = createFixtureModelManifest({ totalSegments: 2 });
  const coord = new DurableCoordinator(executor, manifest, { allowFixtureManifest: true }, repo);
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
    prompt: 'race',
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
    expiresAt: leaseExpiresAt,
  };
  repo.putLease(lease);
  repo.appendAttempt(requestId, { ...identity, startedAt: createdAt });
  const checkpoint = await createCheckpointEnvelope({
    requestId,
    attemptId: identity.attemptId,
    segmentIndex: 0,
    workerId: identity.workerId,
    workerGeneration: identity.workerGeneration,
    modelManifestDigest: manifest.manifestDigest,
    formatVersion: manifest.checkpointFormat,
    payload: new Uint8Array([7, 8, 9]),
    ttlMs: 60_000,
    createdAt,
  });
  const result: ExecutionResult = { identity, checkpoint, processingTimeMs: 1 };
  return { coord, manifest, requestId, identity, checkpoint, result };
}

const repositories = [
  ['InMemoryRepository', () => new InMemoryRepository() as DurableRepository],
  ['DurableObjectRepository', () => new DurableObjectRepository(new CloneOnAccessKv()) as DurableRepository],
] as const;

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe.each(repositories)('%s checkpoint commit race', (_name, makeRepo) => {
  it('suppresses L1 after L2 replaces the active lease and preserves L2', async () => {
    const repo = makeRepo();
    const f = await fixture(repo);
    const deferred = deferredDigest();
    const acceptancePromise = f.coord.handleWorkerResult(f.result);
    await deferred.started;

    const replacement: Lease = {
      requestId: f.requestId,
      attemptId: generateAttemptId(),
      leaseId: generateLeaseId(),
      workerId: workerId('worker-b'),
      workerGeneration: generateWorkerGeneration(),
      segmentIndex: 0,
      modelManifestDigest: f.manifest.manifestDigest,
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    };
    repo.putLease(replacement);
    deferred.release();

    await expect(acceptancePromise).resolves.toMatchObject({ kind: 'identity-mismatch' });
    expect(repo.getCheckpoint(f.requestId, 0)).toBeUndefined();
    expect(repo.getActiveLease(f.requestId)?.leaseId).toBe(replacement.leaseId);
    expect(repo.listAttempts(f.requestId)[0]?.outcome).toBeUndefined();
  });

  it('does not commit after the request leaves running during digest validation', async () => {
    const repo = makeRepo();
    const f = await fixture(repo);
    const deferred = deferredDigest();
    const acceptancePromise = f.coord.handleWorkerResult(f.result);
    await deferred.started;

    expect(repo.transitionStage(f.requestId, 'running', 'cancelled')).toBe(true);
    deferred.release();

    await expect(acceptancePromise).resolves.toMatchObject({ kind: 'protocol-violation' });
    expect(repo.getCheckpoint(f.requestId, 0)).toBeUndefined();
    expect(repo.getActiveLease(f.requestId)?.leaseId).toBe(f.identity.leaseId);
  });

  it('commits the owned checkpoint snapshot even if the caller mutates its object while digesting', async () => {
    const repo = makeRepo();
    const f = await fixture(repo);
    const expectedPayload = [...f.checkpoint.payload];
    const expectedDigest = f.checkpoint.payloadDigest;
    const deferred = deferredDigest();
    const acceptancePromise = f.coord.handleWorkerResult(f.result);
    await deferred.started;

    f.checkpoint.payload[0] = 255;
    deferred.release();

    await expect(acceptancePromise).resolves.toMatchObject({ kind: 'accepted', isFinal: false });
    const stored = repo.getCheckpoint(f.requestId, 0)!;
    expect([...stored.payload]).toEqual(expectedPayload);
    expect(stored.payloadDigest).toBe(expectedDigest);
    expect(repo.getActiveLease(f.requestId)).toBeUndefined();
  });

  it('rejects a lease that expires while digest validation is pending', async () => {
    vi.useFakeTimers();
    const base = new Date('2026-09-05T00:00:00.000Z');
    vi.setSystemTime(base);
    const repo = makeRepo();
    const f = await fixture(repo, base.getTime() + 5);
    const deferred = deferredDigest();
    const acceptancePromise = f.coord.acceptResult(f.result, base.getTime());
    await deferred.started;

    vi.setSystemTime(base.getTime() + 10);
    deferred.release();

    await expect(acceptancePromise).resolves.toMatchObject({
      kind: 'identity-mismatch',
      reason: 'lease-expired',
    });
    expect(repo.getCheckpoint(f.requestId, 0)).toBeUndefined();
    expect(repo.getActiveLease(f.requestId)?.leaseId).toBe(f.identity.leaseId);
  });
});
