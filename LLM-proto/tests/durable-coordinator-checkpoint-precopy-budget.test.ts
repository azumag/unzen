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

async function fixture(
  usePublicBoundary: boolean,
  maxCheckpointBytes = 2,
  segmentIndex = 0,
) {
  const repo = new InMemoryRepository();
  const manifest = createFixtureModelManifest({ totalSegments: 2 });
  const options = { allowFixtureManifest: true, maxCheckpointBytes } as const;
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
    segmentIndex,
  };
  const createdAt = Date.now();
  repo.createRequest({
    requestId,
    prompt: 'oversized-checkpoint',
    stage: 'accepted',
    createdAt,
    currentSegment: segmentIndex,
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

function trackCheckpointWork() {
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
  return {
    copies: () => typedArrayCopies,
    digestSpy,
  };
}

function withCheckpointPayload(result: ExecutionResult, payload: Uint8Array): ExecutionResult {
  return {
    ...result,
    checkpoint: {
      ...result.checkpoint!,
      payload,
    },
  };
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
    const work = trackCheckpointWork();

    await expect(f.coord.acceptResult(f.result, f.createdAt)).resolves.toEqual({
      kind: 'checkpoint-rejected',
      message: 'checkpoint payload 3B exceeds the 2B limit',
    });

    expect(work.copies()).toBe(0);
    expect(work.digestSpy).not.toHaveBeenCalled();
    expect(f.repo.getCheckpoint(f.requestId, 0)).toBeUndefined();
  });

  it('rejects a Proxy-wrapped Uint8Array without leaking a native TypedArray error', async () => {
    const f = await fixture(usePublicBoundary, 64);
    const digestSpy = vi.spyOn(globalThis.crypto.subtle, 'digest');
    const proxiedPayload = new Proxy(f.result.checkpoint!.payload, {});

    await expect(
      f.coord.acceptResult(withCheckpointPayload(f.result, proxiedPayload), f.createdAt),
    ).resolves.toEqual({
      kind: 'checkpoint-rejected',
      message: 'checkpoint payload must be a Uint8Array',
    });

    expect(digestSpy).not.toHaveBeenCalled();
    expect(f.repo.getCheckpoint(f.requestId, 0)).toBeUndefined();
  });

  it('uses intrinsic byte length when a genuine Uint8Array shadows byteLength', async () => {
    const f = await fixture(usePublicBoundary);
    const digestSpy = vi.spyOn(globalThis.crypto.subtle, 'digest');
    const hostilePayload = new Uint8Array([1, 2, 3]);
    Object.defineProperty(hostilePayload, 'byteLength', {
      configurable: true,
      get: () => 1,
    });
    Object.defineProperty(hostilePayload, Symbol.iterator, {
      configurable: true,
      value: () => {
        throw new Error('checkpoint payload iterator must not run');
      },
    });
    Object.defineProperty(hostilePayload, 'slice', {
      configurable: true,
      value: () => {
        throw new Error('checkpoint payload slice must not run');
      },
    });

    expect(hostilePayload.byteLength).toBe(1);
    await expect(
      f.coord.acceptResult(withCheckpointPayload(f.result, hostilePayload), f.createdAt),
    ).resolves.toEqual({
      kind: 'checkpoint-rejected',
      message: 'checkpoint payload 3B exceeds the 2B limit',
    });

    expect(digestSpy).not.toHaveBeenCalled();
    expect(f.repo.getCheckpoint(f.requestId, 0)).toBeUndefined();
  });
});

describe('direct durable core checkpoint shim runtime boundary', () => {
  it('rejects a revoked result Proxy without leaking Array.isArray errors', async () => {
    const f = await fixture(false, 64);
    const revocable = Proxy.revocable(f.result, {});
    revocable.revoke();

    await expect(
      f.coord.acceptResult(revocable.proxy, f.createdAt),
    ).resolves.toEqual({
      kind: 'protocol-violation',
      message: 'execution result must be a non-null, non-array object',
    });
  });

  it('rejects a revoked checkpoint Proxy with the existing checkpoint-object diagnostic', async () => {
    const f = await fixture(false, 64);
    const revocable = Proxy.revocable(f.result.checkpoint!, {});
    revocable.revoke();

    await expect(
      f.coord.acceptResult({ ...f.result, checkpoint: revocable.proxy }, f.createdAt),
    ).resolves.toEqual({
      kind: 'checkpoint-rejected',
      message: 'checkpoint envelope must be an object',
    });

    expect(f.repo.getCheckpoint(f.requestId, 0)).toBeUndefined();
  });

  it('treats a throwing checkpoint getter as missing without coercing the thrown value', async () => {
    const f = await fixture(false, 64);
    const thrown = hostileThrownValue();
    let reads = 0;
    const result = { ...f.result };
    Object.defineProperty(result, 'checkpoint', {
      configurable: true,
      get() {
        reads += 1;
        throw thrown;
      },
    });

    await expect(
      f.coord.acceptResult(result, f.createdAt),
    ).resolves.toEqual({
      kind: 'protocol-violation',
      message: 'intermediate segment produced no checkpoint',
    });

    expect(reads).toBe(1);
    expect(thrown.toString).not.toHaveBeenCalled();
    expect(thrown[Symbol.toPrimitive]).not.toHaveBeenCalled();
    expect(f.repo.getCheckpoint(f.requestId, 0)).toBeUndefined();
  });

  it('rejects a throwing payload getter without coercing the thrown value', async () => {
    const f = await fixture(false, 64);
    const thrown = hostileThrownValue();
    let reads = 0;
    const checkpoint = { ...f.result.checkpoint! };
    Object.defineProperty(checkpoint, 'payload', {
      configurable: true,
      get() {
        reads += 1;
        throw thrown;
      },
    });

    await expect(
      f.coord.acceptResult({ ...f.result, checkpoint }, f.createdAt),
    ).resolves.toEqual({
      kind: 'checkpoint-rejected',
      message: 'checkpoint payload must be a Uint8Array',
    });

    expect(reads).toBe(1);
    expect(thrown.toString).not.toHaveBeenCalled();
    expect(thrown[Symbol.toPrimitive]).not.toHaveBeenCalled();
    expect(f.repo.getCheckpoint(f.requestId, 0)).toBeUndefined();
  });

  it('does not inspect checkpoint accessors for a final result', async () => {
    const f = await fixture(false, 64, 1);
    let reads = 0;
    const result: ExecutionResult = {
      identity: f.result.identity,
      processingTimeMs: 1,
      output: { tokens: [7], text: 'done' },
    };
    Object.defineProperty(result, 'checkpoint', {
      configurable: true,
      get() {
        reads += 1;
        throw new Error('final result checkpoint must remain lazy');
      },
    });

    await expect(f.coord.acceptResult(result, f.createdAt)).resolves.toEqual({
      kind: 'accepted',
      isFinal: true,
      output: { tokens: [7], text: 'done' },
    });

    expect(reads).toBe(0);
  });
});

describe('direct durable core checkpoint budget configuration', () => {
  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid pre-copy ceiling %p before any ownership copy, digest, or persistence',
    async (maxCheckpointBytes) => {
      const f = await fixture(false, maxCheckpointBytes);
      const work = trackCheckpointWork();

      await expect(f.coord.acceptResult(f.result, f.createdAt)).resolves.toEqual({
        kind: 'checkpoint-rejected',
        message: 'checkpoint payload byte limit must be a non-negative safe integer',
      });

      expect(work.copies()).toBe(0);
      expect(work.digestSpy).not.toHaveBeenCalled();
      expect(f.repo.getCheckpoint(f.requestId, 0)).toBeUndefined();
    },
  );
});
