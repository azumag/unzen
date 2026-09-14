import { describe, expect, it } from 'vitest';
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
import { WorkerTier, workerId } from '../src/types.js';
import type { ResultIdentity } from '../src/durable-types.js';

const executor: DurableSegmentExecutor = {
  execute: async () => {
    throw new Error('not used by final-output ownership tests');
  },
};

function placeRunning(coord: DurableCoordinator, repo: InMemoryRepository): ResultIdentity {
  const worker = workerId('final-output-ownership-worker');
  const registration = coord.registerWorker(
    { workerId: worker, tier: WorkerTier.TIER_3, vramMB: 8_192 },
    'final-output-ownership-connection',
  );
  const requestId = generateRequestId();
  const attemptId = generateAttemptId();
  const leaseId = generateLeaseId();
  const now = Date.now();

  repo.createRequest({
    requestId,
    prompt: 'final output ownership',
    stage: 'accepted',
    createdAt: now,
    currentSegment: 0,
    totalSegments: 1,
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

function fixture() {
  const repo = new InMemoryRepository();
  const coord = new DurableCoordinator(
    executor,
    createFixtureModelManifest({ totalSegments: 1 }),
    { allowFixtureManifest: true, maxRetries: 0, retryDelayMs: 0 },
    repo,
  );
  return { repo, coord, identity: placeRunning(coord, repo) };
}

describe('DurableCoordinator final-output ownership', () => {
  it('captures output fields/token elements once and commits the captured values without caller iteration', async () => {
    const { repo, coord, identity } = fixture();
    let outputReads = 0;
    let tokensReads = 0;
    let textReads = 0;
    let token0Reads = 0;
    let token1Reads = 0;
    let iteratorReads = 0;

    const tokens: number[] = [0, 0];
    Object.defineProperty(tokens, 0, {
      configurable: true,
      enumerable: true,
      get() {
        token0Reads += 1;
        return token0Reads === 1 ? 11 : 911;
      },
    });
    Object.defineProperty(tokens, 1, {
      configurable: true,
      enumerable: true,
      get() {
        token1Reads += 1;
        return token1Reads === 1 ? 12 : 912;
      },
    });
    Object.defineProperty(tokens, Symbol.iterator, {
      configurable: true,
      get() {
        iteratorReads += 1;
        throw new Error('caller token iterator must not be read');
      },
    });

    const output = {
      get tokens() {
        tokensReads += 1;
        return tokensReads === 1 ? tokens : [999];
      },
      get text() {
        textReads += 1;
        return textReads === 1 ? 'captured output' : 'drifted output';
      },
    };
    const result = {
      identity,
      processingTimeMs: 5,
      get output() {
        outputReads += 1;
        return outputReads === 1 ? output : { tokens: [777], text: 'drifted root' };
      },
    };

    await expect(coord.handleWorkerResult(result as never)).resolves.toEqual({
      kind: 'accepted',
      isFinal: true,
      output: { tokens: [11, 12], text: 'captured output' },
    });
    expect({ outputReads, tokensReads, textReads, token0Reads, token1Reads, iteratorReads }).toEqual({
      outputReads: 1,
      tokensReads: 1,
      textReads: 1,
      token0Reads: 1,
      token1Reads: 1,
      iteratorReads: 0,
    });
    expect(repo.getResult(identity.requestId)).toMatchObject({
      tokens: [11, 12],
      text: 'captured output',
    });
  });

  it('does not read text after the first invalid captured token', async () => {
    const { repo, coord, identity } = fixture();
    let token0Reads = 0;
    let token1Reads = 0;
    let textReads = 0;
    const tokens: number[] = [0, 0];
    Object.defineProperty(tokens, 0, {
      configurable: true,
      enumerable: true,
      get() {
        token0Reads += 1;
        return -1;
      },
    });
    Object.defineProperty(tokens, 1, {
      configurable: true,
      enumerable: true,
      get() {
        token1Reads += 1;
        throw new Error('later token must not be read after fail-fast');
      },
    });
    const output = {
      tokens,
      get text() {
        textReads += 1;
        throw new Error('text must not be read after invalid token');
      },
    };

    await expect(coord.handleWorkerResult({ identity, processingTimeMs: 1, output } as never)).resolves.toEqual({
      kind: 'protocol-violation',
      message: 'final output tokens must contain non-negative safe integers',
    });
    expect(token0Reads).toBe(1);
    expect(token1Reads).toBe(0);
    expect(textReads).toBe(0);
    expect(repo.getResult(identity.requestId)).toBeUndefined();
    expect(repo.getRequest(identity.requestId)?.stage).toBe('running');
  });

  it('does not read text when the captured tokens property is not an array', async () => {
    const { repo, coord, identity } = fixture();
    let tokensReads = 0;
    let textReads = 0;
    const output = {
      get tokens() {
        tokensReads += 1;
        return Symbol('bad-tokens');
      },
      get text() {
        textReads += 1;
        throw new Error('text must not be read when tokens is not an array');
      },
    };

    await expect(coord.handleWorkerResult({ identity, processingTimeMs: 1, output } as never)).resolves.toEqual({
      kind: 'protocol-violation',
      message: 'final output tokens must be an array',
    });
    expect(tokensReads).toBe(1);
    expect(textReads).toBe(0);
    expect(repo.getResult(identity.requestId)).toBeUndefined();
  });
});
