import { describe, expect, it, vi } from 'vitest';
import { DurableCoordinator as DurableCoordinatorCore } from '../src/durable-coordinator-core.js';
import type { DurableSegmentExecutor } from '../src/durable-coordinator-core.js';
import { InMemoryRepository } from '../src/durable-repository.js';
import { createCheckpointEnvelope } from '../src/checkpoint-envelope.js';
import { createFixtureModelManifest } from '../src/model-manifest-fixtures.js';
import { ErrorCode } from '../src/errors.js';
import {
  generateAttemptId,
  generateLeaseId,
  generateRequestId,
  generateWorkerGeneration,
} from '../src/ids.js';
import { workerId } from '../src/types.js';
import type { ExecutionFailure, ExecutionResult, Lease, ResultIdentity } from '../src/durable-types.js';

const executor: DurableSegmentExecutor = {
  execute: async () => {
    throw new Error('not used by direct-core runtime boundary tests');
  },
};

function coordinator(repo = new InMemoryRepository(), totalSegments = 2) {
  return {
    repo,
    coord: new DurableCoordinatorCore(
      executor,
      createFixtureModelManifest({ totalSegments }),
      { allowFixtureManifest: true, maxCheckpointBytes: 64 },
      repo,
    ),
  };
}

async function runningResultFixture(segmentIndex: 0 | 1 = 0) {
  const { coord, repo } = coordinator();
  const manifest = createFixtureModelManifest({ totalSegments: 2 });
  const requestId = generateRequestId();
  const identity: ResultIdentity = {
    requestId,
    attemptId: generateAttemptId(),
    leaseId: generateLeaseId(),
    workerId: workerId('direct-core-runtime-worker'),
    workerGeneration: generateWorkerGeneration(),
    segmentIndex,
  };
  const now = Date.now();

  repo.createRequest({
    requestId,
    prompt: 'direct-core runtime boundary',
    stage: 'accepted',
    createdAt: now,
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
    issuedAt: now,
    expiresAt: now + 60_000,
  };
  repo.putLease(lease);

  const checkpoint = await createCheckpointEnvelope({
    requestId,
    attemptId: identity.attemptId,
    segmentIndex,
    workerId: identity.workerId,
    workerGeneration: identity.workerGeneration,
    modelManifestDigest: manifest.manifestDigest,
    formatVersion: manifest.checkpointFormat,
    payload: new Uint8Array([1, 2, 3]),
    ttlMs: 60_000,
    createdAt: now,
  });

  return {
    coord,
    repo,
    now,
    identity,
    result: { identity, checkpoint, processingTimeMs: 1 } satisfies ExecutionResult,
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

function expectProtocolViolation(action: () => void, message: string): void {
  try {
    action();
    throw new Error('expected protocol violation');
  } catch (error) {
    expect(error).toMatchObject({
      code: ErrorCode.ProtocolViolation,
      message,
    });
  }
}

describe('direct DurableCoordinatorCore execution-result runtime boundary', () => {
  it('bounds a throwing root identity getter and does not inspect later fields', async () => {
    const { coord, now } = await runningResultFixture();
    const thrown = hostileThrownValue();
    let processingReads = 0;
    const result = {} as ExecutionResult;
    Object.defineProperty(result, 'identity', {
      get() {
        throw thrown;
      },
    });
    Object.defineProperty(result, 'processingTimeMs', {
      get() {
        processingReads += 1;
        return 1;
      },
    });

    await expect(coord.acceptResult(result, now)).resolves.toEqual({
      kind: 'protocol-violation',
      message: 'execution result identity must be a non-null, non-array object',
    });

    expect(processingReads).toBe(0);
    expect(thrown.toString).not.toHaveBeenCalled();
    expect(thrown[Symbol.toPrimitive]).not.toHaveBeenCalled();
  });

  it('bounds a revoked nested identity Proxy', async () => {
    const f = await runningResultFixture();
    const revocable = Proxy.revocable(f.identity, {});
    revocable.revoke();

    await expect(
      f.coord.acceptResult({ ...f.result, identity: revocable.proxy }, f.now),
    ).resolves.toEqual({
      kind: 'protocol-violation',
      message: 'execution result identity must be a non-null, non-array object',
    });
  });

  it('stops at the first inaccessible identity field without coercion', async () => {
    const f = await runningResultFixture();
    const thrown = hostileThrownValue();
    let attemptReads = 0;
    const identity = { ...f.identity } as ResultIdentity;
    Object.defineProperty(identity, 'requestId', {
      get() {
        throw thrown;
      },
    });
    Object.defineProperty(identity, 'attemptId', {
      get() {
        attemptReads += 1;
        return f.identity.attemptId;
      },
    });

    await expect(
      f.coord.acceptResult({ ...f.result, identity }, f.now),
    ).resolves.toEqual({
      kind: 'protocol-violation',
      message: 'execution result requestId must be a non-empty string',
    });

    expect(attemptReads).toBe(0);
    expect(thrown.toString).not.toHaveBeenCalled();
    expect(thrown[Symbol.toPrimitive]).not.toHaveBeenCalled();
  });

  it('bounds a throwing processingTimeMs getter', async () => {
    const f = await runningResultFixture();
    const thrown = hostileThrownValue();
    const result = { ...f.result } as ExecutionResult;
    Object.defineProperty(result, 'processingTimeMs', {
      get() {
        throw thrown;
      },
    });

    await expect(f.coord.acceptResult(result, f.now)).resolves.toEqual({
      kind: 'protocol-violation',
      message: 'execution result processingTimeMs must be a non-negative finite number',
    });

    expect(thrown.toString).not.toHaveBeenCalled();
    expect(thrown[Symbol.toPrimitive]).not.toHaveBeenCalled();
  });

  it('keeps final output lazy and maps a throwing output getter to output-missing', async () => {
    const f = await runningResultFixture(1);
    const thrown = hostileThrownValue();
    const result = {
      identity: f.identity,
      processingTimeMs: 1,
    } as ExecutionResult;
    Object.defineProperty(result, 'output', {
      get() {
        throw thrown;
      },
    });

    await expect(f.coord.acceptResult(result, f.now)).resolves.toEqual({ kind: 'output-missing' });
    expect(thrown.toString).not.toHaveBeenCalled();
    expect(thrown[Symbol.toPrimitive]).not.toHaveBeenCalled();
  });

  it('rejects a revoked final-output Proxy without leaking Array.isArray errors', async () => {
    const f = await runningResultFixture(1);
    const revocable = Proxy.revocable({ tokens: [1], text: 'done' }, {});
    revocable.revoke();

    await expect(
      f.coord.acceptResult({
        identity: f.identity,
        processingTimeMs: 1,
        output: revocable.proxy,
      }, f.now),
    ).resolves.toEqual({
      kind: 'protocol-violation',
      message: 'final output must be a non-null, non-array object',
    });
  });

  it('bounds hostile token access without running caller iteration or later text access', async () => {
    const f = await runningResultFixture(1);
    const thrown = hostileThrownValue();
    let iteratorCalls = 0;
    let textReads = 0;
    const tokens = [1];
    Object.defineProperty(tokens, '0', {
      get() {
        throw thrown;
      },
    });
    Object.defineProperty(tokens, Symbol.iterator, {
      value() {
        iteratorCalls += 1;
        throw new Error('caller token iterator must not run');
      },
    });
    const output = { tokens } as { tokens: number[]; text: string };
    Object.defineProperty(output, 'text', {
      get() {
        textReads += 1;
        return 'done';
      },
    });

    await expect(
      f.coord.acceptResult({ identity: f.identity, processingTimeMs: 1, output }, f.now),
    ).resolves.toEqual({
      kind: 'protocol-violation',
      message: 'final output tokens must contain non-negative safe integers',
    });

    expect(iteratorCalls).toBe(0);
    expect(textReads).toBe(0);
    expect(thrown.toString).not.toHaveBeenCalled();
    expect(thrown[Symbol.toPrimitive]).not.toHaveBeenCalled();
  });

  it('bounds a throwing final-output text getter', async () => {
    const f = await runningResultFixture(1);
    const thrown = hostileThrownValue();
    const output = { tokens: [1] } as { tokens: number[]; text: string };
    Object.defineProperty(output, 'text', {
      get() {
        throw thrown;
      },
    });

    await expect(
      f.coord.acceptResult({ identity: f.identity, processingTimeMs: 1, output }, f.now),
    ).resolves.toEqual({
      kind: 'protocol-violation',
      message: 'final output text must be a string',
    });

    expect(thrown.toString).not.toHaveBeenCalled();
    expect(thrown[Symbol.toPrimitive]).not.toHaveBeenCalled();
  });

  it('does not inspect final output on an intermediate result', async () => {
    const f = await runningResultFixture(0);
    let outputReads = 0;
    const result = { ...f.result } as ExecutionResult;
    Object.defineProperty(result, 'output', {
      get() {
        outputReads += 1;
        throw new Error('intermediate result output must remain lazy');
      },
    });

    await expect(f.coord.acceptResult(result, f.now)).resolves.toMatchObject({
      kind: 'accepted',
      isFinal: false,
    });
    expect(outputReads).toBe(0);
  });
});

describe('direct DurableCoordinatorCore execution-failure runtime boundary', () => {
  it('rejects a revoked failure root without leaking native errors', () => {
    const { coord } = coordinator();
    const revocable = Proxy.revocable({
      identity: {},
      code: ErrorCode.InvalidInput,
      message: 'bad',
    }, {});
    revocable.revoke();

    expectProtocolViolation(
      () => coord.handleWorkerFailure(revocable.proxy as unknown as ExecutionFailure),
      'execution failure must be a non-null, non-array object',
    );
  });

  it('bounds a throwing failure identity getter and does not inspect code', () => {
    const { coord } = coordinator();
    const thrown = hostileThrownValue();
    let codeReads = 0;
    const failure = {} as ExecutionFailure;
    Object.defineProperty(failure, 'identity', {
      get() {
        throw thrown;
      },
    });
    Object.defineProperty(failure, 'code', {
      get() {
        codeReads += 1;
        return ErrorCode.InvalidInput;
      },
    });

    expectProtocolViolation(
      () => coord.handleWorkerFailure(failure),
      'execution failure identity must be a non-null, non-array object',
    );
    expect(codeReads).toBe(0);
    expect(thrown.toString).not.toHaveBeenCalled();
    expect(thrown[Symbol.toPrimitive]).not.toHaveBeenCalled();
  });

  it('bounds a throwing failure code getter and does not inspect message', async () => {
    const f = await runningResultFixture();
    const thrown = hostileThrownValue();
    let messageReads = 0;
    const failure = { identity: f.identity } as ExecutionFailure;
    Object.defineProperty(failure, 'code', {
      get() {
        throw thrown;
      },
    });
    Object.defineProperty(failure, 'message', {
      get() {
        messageReads += 1;
        return 'must remain unread';
      },
    });

    expectProtocolViolation(
      () => f.coord.handleWorkerFailure(failure),
      'execution failure code must be a recognized ErrorCode',
    );
    expect(messageReads).toBe(0);
    expect(thrown.toString).not.toHaveBeenCalled();
    expect(thrown[Symbol.toPrimitive]).not.toHaveBeenCalled();
  });

  it('bounds a throwing failure message getter without coercion', async () => {
    const f = await runningResultFixture();
    const thrown = hostileThrownValue();
    const failure = {
      identity: f.identity,
      code: ErrorCode.InvalidInput,
    } as ExecutionFailure;
    Object.defineProperty(failure, 'message', {
      get() {
        throw thrown;
      },
    });

    expectProtocolViolation(
      () => f.coord.handleWorkerFailure(failure),
      'execution failure message must be a string',
    );
    expect(thrown.toString).not.toHaveBeenCalled();
    expect(thrown[Symbol.toPrimitive]).not.toHaveBeenCalled();
  });
});
