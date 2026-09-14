import { describe, expect, it } from 'vitest';
import {
  DurableCoordinator,
  type DurableSegmentExecutor,
} from '../src/durable-coordinator.js';
import { InMemoryRepository } from '../src/durable-repository.js';
import { ErrorCode, UnzenError } from '../src/errors.js';
import { createFixtureModelManifest } from '../src/model-manifest-fixtures.js';
import { WorkerTier, workerId } from '../src/types.js';

const executor: DurableSegmentExecutor = {
  execute: async () => {
    throw new Error('not used by submission-option ownership tests');
  },
};

function coordinator(repo = new InMemoryRepository()) {
  return {
    repo,
    coord: new DurableCoordinator(
      executor,
      createFixtureModelManifest({ totalSegments: 1 }),
      { allowFixtureManifest: true, maxRetries: 0, retryDelayMs: 0 },
      repo,
    ),
  };
}

describe('DurableCoordinator submission option ownership', () => {
  it('captures all caller-owned top-level option fields once and persists the captured values', async () => {
    const { coord, repo } = coordinator();
    const reads = { idempotencyKey: 0, signal: 0, timeoutMs: 0 };
    const options = {
      get idempotencyKey() {
        reads.idempotencyKey += 1;
        return reads.idempotencyKey === 1 ? 'owned-submission-key' : 123 as never;
      },
      get signal() {
        reads.signal += 1;
        return reads.signal === 1 ? undefined : {} as AbortSignal;
      },
      get timeoutMs() {
        reads.timeoutMs += 1;
        return reads.timeoutMs === 1 ? 50_000 : -1;
      },
    };

    const submission = coord.submit('owned prompt', options);
    expect(reads).toEqual({ idempotencyKey: 1, signal: 1, timeoutMs: 1 });

    const record = repo.getRequest(submission.requestId);
    expect(record?.idempotencyKey).toBe('owned-submission-key');
    expect(record?.timeoutMs).toBe(50_000);

    submission.cancel();
    await expect(submission.result).rejects.toBeInstanceOf(Error);
  });

  it('preserves inherited top-level option lookup', async () => {
    const { coord, repo } = coordinator();
    const options = Object.create({
      idempotencyKey: 'inherited-submission-key',
      timeoutMs: 50_000,
    }) as {
      idempotencyKey?: string;
      signal?: AbortSignal;
      timeoutMs?: number;
    };

    const submission = coord.submit('inherited prompt', options);
    const record = repo.getRequest(submission.requestId);
    expect(record?.idempotencyKey).toBe('inherited-submission-key');
    expect(record?.timeoutMs).toBe(50_000);

    submission.cancel();
    await expect(submission.result).rejects.toBeInstanceOf(Error);
  });

  it('preserves non-enumerable top-level option lookup', async () => {
    const { coord, repo } = coordinator();
    const options: Record<string, unknown> = {};
    Object.defineProperty(options, 'idempotencyKey', {
      enumerable: false,
      value: 'non-enumerable-submission-key',
    });
    Object.defineProperty(options, 'timeoutMs', {
      enumerable: false,
      value: 50_000,
    });

    const submission = coord.submit('non-enumerable prompt', options as never);
    const record = repo.getRequest(submission.requestId);
    expect(record?.idempotencyKey).toBe('non-enumerable-submission-key');
    expect(record?.timeoutMs).toBe(50_000);

    submission.cancel();
    await expect(submission.result).rejects.toBeInstanceOf(Error);
  });

  it('rejects malformed option containers with the existing protocol error before durable mutation', () => {
    for (const options of [null, [], 'options', 1, () => undefined]) {
      const { coord, repo } = coordinator();
      try {
        coord.submit('prompt', options as never);
        throw new Error('expected options rejection');
      } catch (error) {
        expect(error).toBeInstanceOf(UnzenError);
        expect((error as UnzenError).code).toBe(ErrorCode.ProtocolViolation);
        expect((error as Error).message).toBe(
          'submission options must be a non-null, non-array object',
        );
      }
      expect(repo.listRequests()).toHaveLength(0);
    }
  });

  it('lets the existing core validator reject the captured timeout once without request creation', () => {
    const { coord, repo } = coordinator();
    let timeoutReads = 0;
    const options = {
      get timeoutMs() {
        timeoutReads += 1;
        return -1;
      },
    };

    try {
      coord.submit('prompt', options);
      throw new Error('expected timeout rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(UnzenError);
      expect((error as UnzenError).code).toBe(ErrorCode.ProtocolViolation);
      expect((error as Error).message).toBe(
        'submission timeoutMs must be a non-negative finite number',
      );
    }
    expect(timeoutReads).toBe(1);
    expect(repo.listRequests()).toHaveLength(0);
  });

  it('keeps the captured AbortSignal identity live for later aborts', async () => {
    const repo = new InMemoryRepository();
    const controller = new AbortController();
    const coord = new DurableCoordinator(
      {
        execute: async (_workerId, _assignment, options) => new Promise((_resolve, reject) => {
          const signal = options?.signal;
          const rejectAbort = () => reject(new DOMException('AbortError', 'AbortError'));
          if (signal?.aborted) rejectAbort();
          else signal?.addEventListener('abort', rejectAbort, { once: true });
        }),
      },
      createFixtureModelManifest({ totalSegments: 1 }),
      { allowFixtureManifest: true, maxRetries: 0, retryDelayMs: 0 },
      repo,
    );
    coord.registerWorker(
      { workerId: workerId('signal-worker'), tier: WorkerTier.TIER_2, vramMB: 8_192 },
      'signal-connection',
    );

    const submission = coord.submit('signal prompt', { signal: controller.signal });
    controller.abort();

    await expect(submission.result).rejects.toMatchObject({ code: ErrorCode.UserCancellation });
    expect(repo.getRequest(submission.requestId)?.stage).toBe('cancelled');
  });
});
