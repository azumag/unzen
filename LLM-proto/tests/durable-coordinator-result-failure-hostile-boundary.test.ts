import { describe, expect, it } from 'vitest';
import {
  DurableCoordinator,
  type DurableSegmentExecutor,
} from '../src/durable-coordinator.js';
import { InMemoryRepository } from '../src/durable-repository.js';
import { ErrorCode, UnzenError } from '../src/errors.js';
import {
  generateAttemptId,
  generateLeaseId,
  generateRequestId,
} from '../src/ids.js';
import { createFixtureModelManifest } from '../src/model-manifest-fixtures.js';
import type { ResultIdentity } from '../src/durable-types.js';
import { WorkerTier, workerId } from '../src/types.js';

const executor: DurableSegmentExecutor = {
  execute: async () => {
    throw new Error('not used by hostile result/failure boundary tests');
  },
};

function coordinator(repo = new InMemoryRepository(), totalSegments = 1) {
  return {
    repo,
    coord: new DurableCoordinator(
      executor,
      createFixtureModelManifest({ totalSegments }),
      { allowFixtureManifest: true, maxRetries: 0, retryDelayMs: 0 },
      repo,
    ),
  };
}

function placeRunning(
  coord: DurableCoordinator,
  repo: InMemoryRepository,
  totalSegments = 1,
): ResultIdentity {
  const worker = workerId('hostile-result-boundary-worker');
  const registration = coord.registerWorker(
    { workerId: worker, tier: WorkerTier.TIER_3, vramMB: 8_192 },
    'hostile-result-boundary-connection',
  );
  const requestId = generateRequestId();
  const attemptId = generateAttemptId();
  const leaseId = generateLeaseId();
  const now = Date.now();

  repo.createRequest({
    requestId,
    prompt: 'hostile result boundary',
    stage: 'accepted',
    createdAt: now,
    currentSegment: 0,
    totalSegments,
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
    requestId,
    attemptId,
    leaseId,
    workerId: worker,
    workerGeneration: registration.generation,
    segmentIndex: 0,
  };
}

function hostileThrownValue(onCoerce: () => void) {
  return {
    toString() {
      onCoerce();
      throw new Error('hostile value must never be stringified');
    },
    [Symbol.toPrimitive]() {
      onCoerce();
      throw new Error('hostile value must never be coerced');
    },
  };
}

function captureThrown(fn: () => void): unknown {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('DurableCoordinator hostile execution result/failure boundary', () => {
  it('fails closed on a revoked execution-result root', async () => {
    const { coord } = coordinator();
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();

    await expect(coord.handleWorkerResult(revoked.proxy as never)).resolves.toMatchObject({
      kind: 'protocol-violation',
    });
  });

  it('fails closed on a throwing result identity getter without touching later fields or coercing the thrown value', async () => {
    const { coord } = coordinator();
    let processingReads = 0;
    let coercions = 0;
    const hostile = hostileThrownValue(() => { coercions += 1; });
    const result = {
      get identity() {
        throw hostile;
      },
      get processingTimeMs() {
        processingReads += 1;
        throw new Error('processingTimeMs must not be read');
      },
    };

    await expect(coord.handleWorkerResult(result as never)).resolves.toMatchObject({
      kind: 'protocol-violation',
    });
    expect(processingReads).toBe(0);
    expect(coercions).toBe(0);
  });

  it('fails closed on a throwing nested result identity getter in field order', async () => {
    const { coord } = coordinator();
    let attemptReads = 0;
    const result = {
      identity: {
        get requestId() {
          throw new Error('hostile requestId');
        },
        get attemptId() {
          attemptReads += 1;
          throw new Error('attemptId must not be read');
        },
      },
      processingTimeMs: 1,
    };

    await expect(coord.handleWorkerResult(result as never)).resolves.toMatchObject({
      kind: 'protocol-violation',
    });
    expect(attemptReads).toBe(0);
  });

  it('fails closed on a throwing processingTimeMs getter before branch payload access', async () => {
    const { coord } = coordinator();
    let outputReads = 0;
    let checkpointReads = 0;
    const result = {
      identity: {
        requestId: generateRequestId(),
        attemptId: generateAttemptId(),
        leaseId: generateLeaseId(),
        workerId: workerId('hostile-processing-worker'),
        workerGeneration: 'generation-1',
        segmentIndex: 0,
      },
      get processingTimeMs() {
        throw new Error('hostile processingTimeMs');
      },
      get output() {
        outputReads += 1;
        throw new Error('output must not be read');
      },
      get checkpoint() {
        checkpointReads += 1;
        throw new Error('checkpoint must not be read');
      },
    };

    await expect(coord.handleWorkerResult(result as never)).resolves.toMatchObject({
      kind: 'protocol-violation',
    });
    expect(outputReads).toBe(0);
    expect(checkpointReads).toBe(0);
  });

  it.each([
    ['tokens getter', (coercions: { value: number }) => ({
      get tokens() {
        throw hostileThrownValue(() => { coercions.value += 1; });
      },
      get text() {
        throw new Error('text must not be read after tokens failure');
      },
    })],
    ['revoked tokens array', (_coercions: { value: number }) => {
      const revoked = Proxy.revocable([], {});
      revoked.revoke();
      return { tokens: revoked.proxy, text: 'ignored' };
    }],
    ['tokens length trap', (_coercions: { value: number }) => ({
      tokens: new Proxy([], {
        get(target, property, receiver) {
          if (property === 'length') throw new Error('hostile length');
          return Reflect.get(target, property, receiver);
        },
      }),
      text: 'ignored',
    })],
    ['token index trap', (_coercions: { value: number }) => ({
      tokens: new Proxy([1], {
        get(target, property, receiver) {
          if (property === '0') throw new Error('hostile token index');
          return Reflect.get(target, property, receiver);
        },
      }),
      get text() {
        throw new Error('text must not be read after token failure');
      },
    })],
  ])('fails closed on hostile final-output %s access', async (_name, makeOutput) => {
    const { coord, repo } = coordinator();
    const identity = placeRunning(coord, repo);
    const coercions = { value: 0 };
    const result = {
      identity,
      processingTimeMs: 1,
      output: makeOutput(coercions),
      get checkpoint() {
        throw new Error('checkpoint must not be read on the final branch');
      },
    };

    await expect(coord.handleWorkerResult(result as never)).resolves.toMatchObject({
      kind: 'protocol-violation',
    });
    expect(coercions.value).toBe(0);
  });

  it('fails closed on a throwing final-output text getter without coercing the thrown value', async () => {
    const { coord, repo } = coordinator();
    const identity = placeRunning(coord, repo);
    let coercions = 0;
    const result = {
      identity,
      processingTimeMs: 1,
      output: {
        tokens: [1, 2],
        get text() {
          throw hostileThrownValue(() => { coercions += 1; });
        },
      },
    };

    await expect(coord.handleWorkerResult(result as never)).resolves.toMatchObject({
      kind: 'protocol-violation',
    });
    expect(coercions).toBe(0);
  });

  it('keeps intermediate checkpoint access lazy when final output is not reached', async () => {
    const { coord, repo } = coordinator(new InMemoryRepository(), 2);
    const identity = placeRunning(coord, repo, 2);
    let outputReads = 0;
    const result = {
      identity,
      processingTimeMs: 1,
      get output() {
        outputReads += 1;
        throw new Error('output must not be read on the intermediate branch');
      },
      get checkpoint() {
        throw new Error('hostile checkpoint getter');
      },
    };

    await expect(coord.handleWorkerResult(result as never)).resolves.toMatchObject({
      kind: 'protocol-violation',
    });
    expect(outputReads).toBe(0);
  });

  it('fails closed on a revoked execution-failure root', () => {
    const { coord } = coordinator();
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();

    const error = captureThrown(() => coord.handleWorkerFailure(revoked.proxy as never));
    expect(error).toBeInstanceOf(UnzenError);
    expect((error as UnzenError).code).toBe(ErrorCode.ProtocolViolation);
  });

  it('fails closed on a throwing failure identity getter without reading code or coercing the thrown value', () => {
    const { coord } = coordinator();
    let codeReads = 0;
    let coercions = 0;
    const hostile = hostileThrownValue(() => { coercions += 1; });
    const failure = {
      get identity() {
        throw hostile;
      },
      get code() {
        codeReads += 1;
        throw new Error('code must not be read');
      },
    };

    const error = captureThrown(() => coord.handleWorkerFailure(failure as never));
    expect(error).toBeInstanceOf(UnzenError);
    expect((error as UnzenError).code).toBe(ErrorCode.ProtocolViolation);
    expect(error).not.toBe(hostile);
    expect(codeReads).toBe(0);
    expect(coercions).toBe(0);
  });

  it('fails closed on a throwing failure code getter before message access', () => {
    const { coord, repo } = coordinator();
    const identity = placeRunning(coord, repo);
    let messageReads = 0;
    const failure = {
      identity,
      get code() {
        throw new Error('hostile code');
      },
      get message() {
        messageReads += 1;
        throw new Error('message must not be read');
      },
    };

    const error = captureThrown(() => coord.handleWorkerFailure(failure as never));
    expect(error).toBeInstanceOf(UnzenError);
    expect((error as UnzenError).code).toBe(ErrorCode.ProtocolViolation);
    expect(messageReads).toBe(0);
    expect(repo.getActiveLease(identity.requestId)).toBeDefined();
  });

  it('fails closed on a throwing failure message getter without coercing the thrown value', () => {
    const { coord, repo } = coordinator();
    const identity = placeRunning(coord, repo);
    let coercions = 0;
    const hostile = hostileThrownValue(() => { coercions += 1; });
    const failure = {
      identity,
      code: ErrorCode.InvalidInput,
      get message() {
        throw hostile;
      },
    };

    const error = captureThrown(() => coord.handleWorkerFailure(failure as never));
    expect(error).toBeInstanceOf(UnzenError);
    expect((error as UnzenError).code).toBe(ErrorCode.ProtocolViolation);
    expect(error).not.toBe(hostile);
    expect(coercions).toBe(0);
    expect(repo.getActiveLease(identity.requestId)).toBeDefined();
  });
});
