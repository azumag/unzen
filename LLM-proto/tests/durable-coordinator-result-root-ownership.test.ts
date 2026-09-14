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
    throw new Error('not used by result ownership tests');
  },
};

function coordinator(repo: InMemoryRepository, totalSegments: number) {
  return new DurableCoordinator(
    executor,
    createFixtureModelManifest({ totalSegments }),
    { allowFixtureManifest: true, maxRetries: 0, retryDelayMs: 0 },
    repo,
  );
}

function placeRunning(
  coord: DurableCoordinator,
  repo: InMemoryRepository,
  totalSegments: number,
): ResultIdentity {
  const worker = workerId('result-ownership-worker');
  const registration = coord.registerWorker(
    { workerId: worker, tier: WorkerTier.TIER_3, vramMB: 8_192 },
    'result-ownership-connection',
  );
  const requestId = generateRequestId();
  const attemptId = generateAttemptId();
  const leaseId = generateLeaseId();
  const now = Date.now();

  repo.createRequest({
    requestId,
    prompt: 'result ownership',
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

describe('DurableCoordinator worker result root ownership', () => {
  it('captures root identity/processing once and lazily memoizes the final output reference', async () => {
    const repo = new InMemoryRepository();
    const coord = coordinator(repo, 1);
    const expected = placeRunning(coord, repo, 1);
    const reads: Record<string, number> = {};
    const count = (field: string) => {
      reads[field] = (reads[field] ?? 0) + 1;
      return reads[field];
    };

    const identity = {
      get requestId() {
        return count('requestId') === 1 ? expected.requestId : generateRequestId();
      },
      get attemptId() {
        return count('attemptId') === 1 ? expected.attemptId : generateAttemptId();
      },
      get leaseId() {
        return count('leaseId') === 1 ? expected.leaseId : generateLeaseId();
      },
      get workerId() {
        return count('workerId') === 1 ? expected.workerId : workerId('drifted-result-worker');
      },
      get workerGeneration() {
        return count('workerGeneration') === 1 ? expected.workerGeneration : 'drifted-generation' as never;
      },
      get segmentIndex() {
        return count('segmentIndex') === 1 ? 0 : 999;
      },
    };
    const output = { tokens: [7, 8], text: 'captured output' };
    const result = {
      get identity() {
        count('identity');
        return identity;
      },
      get processingTimeMs() {
        return count('processingTimeMs') === 1 ? 12 : -1;
      },
      get output() {
        if (count('output') === 1) return output;
        throw new Error('output must not be re-read from the caller');
      },
      get checkpoint() {
        count('checkpoint');
        throw new Error('checkpoint must not be read on the final branch');
      },
    };

    await expect(coord.handleWorkerResult(result as never)).resolves.toEqual({
      kind: 'accepted',
      isFinal: true,
      output,
    });
    expect(reads).toEqual({
      identity: 1,
      requestId: 1,
      attemptId: 1,
      leaseId: 1,
      workerId: 1,
      workerGeneration: 1,
      segmentIndex: 1,
      processingTimeMs: 1,
      output: 1,
    });
  });

  it('preserves identity fail-fast ordering without touching later result getters', async () => {
    const coord = coordinator(new InMemoryRepository(), 1);
    const reads = { attemptId: 0, processingTimeMs: 0, output: 0, checkpoint: 0 };
    const result = {
      identity: {
        requestId: Symbol('bad-request'),
        get attemptId() {
          reads.attemptId += 1;
          throw new Error('attemptId must not be read');
        },
      },
      get processingTimeMs() {
        reads.processingTimeMs += 1;
        throw new Error('processingTimeMs must not be read');
      },
      get output() {
        reads.output += 1;
        throw new Error('output must not be read');
      },
      get checkpoint() {
        reads.checkpoint += 1;
        throw new Error('checkpoint must not be read');
      },
    };

    await expect(coord.handleWorkerResult(result as never)).resolves.toEqual({
      kind: 'protocol-violation',
      message: 'execution result requestId must be a non-empty string',
    });
    expect(reads).toEqual({ attemptId: 0, processingTimeMs: 0, output: 0, checkpoint: 0 });
  });

  it('preserves processing-time fail-fast ordering before branch payload reads', async () => {
    const coord = coordinator(new InMemoryRepository(), 1);
    const reads = { processingTimeMs: 0, output: 0, checkpoint: 0 };
    const result = {
      identity: {
        requestId: generateRequestId(),
        attemptId: generateAttemptId(),
        leaseId: generateLeaseId(),
        workerId: workerId('processing-fail-fast-worker'),
        workerGeneration: 'generation-1',
        segmentIndex: 0,
      },
      get processingTimeMs() {
        reads.processingTimeMs += 1;
        return -1;
      },
      get output() {
        reads.output += 1;
        throw new Error('output must not be read');
      },
      get checkpoint() {
        reads.checkpoint += 1;
        throw new Error('checkpoint must not be read');
      },
    };

    await expect(coord.handleWorkerResult(result as never)).resolves.toEqual({
      kind: 'protocol-violation',
      message: 'execution result processingTimeMs must be a non-negative finite number',
    });
    expect(reads).toEqual({ processingTimeMs: 1, output: 0, checkpoint: 0 });
  });

  it('lazily memoizes the intermediate checkpoint reference without reading output', async () => {
    const repo = new InMemoryRepository();
    const coord = coordinator(repo, 2);
    const identity = placeRunning(coord, repo, 2);
    let checkpointReads = 0;
    let outputReads = 0;
    const result = {
      identity,
      processingTimeMs: 3,
      get checkpoint() {
        checkpointReads += 1;
        if (checkpointReads === 1) return undefined;
        throw new Error('checkpoint must not be re-read from the caller');
      },
      get output() {
        outputReads += 1;
        throw new Error('output must not be read on the intermediate branch');
      },
    };

    await expect(coord.handleWorkerResult(result as never)).resolves.toEqual({
      kind: 'protocol-violation',
      message: 'intermediate segment produced no checkpoint',
    });
    expect(checkpointReads).toBe(1);
    expect(outputReads).toBe(0);
  });
});
