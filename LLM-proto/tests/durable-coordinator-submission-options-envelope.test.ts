import { describe, expect, it, vi } from 'vitest';
import { DurableCoordinator } from '../src/durable-coordinator.js';
import type { DurableSegmentExecutor } from '../src/durable-coordinator.js';
import { InMemoryRepository } from '../src/durable-repository.js';
import { ErrorCode, UnzenError } from '../src/errors.js';
import type { IdempotencyKey } from '../src/ids.js';
import { createFixtureModelManifest } from '../src/model-manifest-fixtures.js';
import type { InferenceRequestId } from '../src/types.js';

const executor: DurableSegmentExecutor = {
  async execute() {
    throw new Error('executor should not run');
  },
};

class CountingRepository extends InMemoryRepository {
  idempotencyReads = 0;
  idempotencyWrites = 0;

  override getIdempotencyMapping(key: IdempotencyKey): InferenceRequestId | undefined {
    this.idempotencyReads += 1;
    return super.getIdempotencyMapping(key);
  }

  override putIdempotencyMapping(key: IdempotencyKey, requestId: InferenceRequestId): boolean {
    this.idempotencyWrites += 1;
    return super.putIdempotencyMapping(key, requestId);
  }
}

function coordinator(repo: CountingRepository): DurableCoordinator {
  return new DurableCoordinator(
    executor,
    createFixtureModelManifest({ totalSegments: 1 }),
    { allowFixtureManifest: true, maxRetries: 0, retryDelayMs: 0 },
    repo,
  );
}

function expectRejectedBeforeMutation(
  coord: DurableCoordinator,
  repo: CountingRepository,
  options: unknown,
  expectedMessage: string,
): void {
  let thrown: unknown;
  try {
    coord.submit('prompt', options as never);
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(UnzenError);
  expect((thrown as UnzenError).code).toBe(ErrorCode.ProtocolViolation);
  expect((thrown as Error).message).toBe(expectedMessage);
  expect(repo.idempotencyReads).toBe(0);
  expect(repo.idempotencyWrites).toBe(0);
  expect(repo.listRequests()).toEqual([]);
  expect(coord.activeRequestCount).toBe(0);
}

describe('DurableCoordinator submission options runtime envelope', () => {
  it.each([null, 42, true, 'options', [], Symbol('options'), () => undefined])(
    'rejects malformed options container %p before durable or in-flight mutation',
    (options) => {
      const repo = new CountingRepository();
      const coord = coordinator(repo);

      expectRejectedBeforeMutation(
        coord,
        repo,
        options,
        'submission options must be a non-null, non-array object',
      );
    },
  );

  it.each(['1000', Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, Symbol('timeout'), {}])(
    'rejects malformed timeoutMs %p before idempotency or durable mutation',
    (timeoutMs) => {
      const repo = new CountingRepository();
      const coord = coordinator(repo);

      expectRejectedBeforeMutation(
        coord,
        repo,
        { idempotencyKey: 'must-not-bind', timeoutMs },
        'submission timeoutMs must be a non-negative finite number',
      );
    },
  );

  it('rejects malformed timeoutMs before creating a deadline timer', () => {
    const repo = new CountingRepository();
    const coord = coordinator(repo);
    const timerSpy = vi.spyOn(globalThis, 'setTimeout');

    try {
      expectRejectedBeforeMutation(
        coord,
        repo,
        { idempotencyKey: 'must-not-bind', timeoutMs: '1000' },
        'submission timeoutMs must be a non-negative finite number',
      );
      expect(timerSpy).not.toHaveBeenCalled();
    } finally {
      timerSpy.mockRestore();
    }
  });

  it.each([null, 42, 'signal', [], Symbol('signal')])(
    'rejects non-object signal %p before idempotency or durable mutation',
    (signal) => {
      const repo = new CountingRepository();
      const coord = coordinator(repo);

      expectRejectedBeforeMutation(
        coord,
        repo,
        { idempotencyKey: 'must-not-bind', signal },
        'submission signal must be an AbortSignal-compatible object',
      );
    },
  );

  it.each([
    {},
    { aborted: false },
    { aborted: false, addEventListener() {} },
    { aborted: false, removeEventListener() {} },
    { aborted: 'false', addEventListener() {}, removeEventListener() {} },
    { aborted: false, addEventListener: true, removeEventListener() {} },
    { aborted: false, addEventListener() {}, removeEventListener: true },
  ])('rejects signal with malformed AbortSignal surface %# before durable mutation', (signal) => {
    const repo = new CountingRepository();
    const coord = coordinator(repo);

    expectRejectedBeforeMutation(
      coord,
      repo,
      { idempotencyKey: 'must-not-bind', signal },
      'submission signal must expose boolean aborted and event-listener methods',
    );
  });

  it('rejects malformed signal before invoking listener methods', () => {
    const repo = new CountingRepository();
    const coord = coordinator(repo);
    let added = 0;
    let removed = 0;
    const signal = {
      aborted: 'false',
      addEventListener() {
        added += 1;
      },
      removeEventListener() {
        removed += 1;
      },
    };

    expectRejectedBeforeMutation(
      coord,
      repo,
      { idempotencyKey: 'must-not-bind', signal },
      'submission signal must expose boolean aborted and event-listener methods',
    );
    expect(added).toBe(0);
    expect(removed).toBe(0);
  });

  it('accepts a structurally compatible cross-realm-style signal without instanceof checks', async () => {
    const repo = new CountingRepository();
    const coord = coordinator(repo);
    let added = 0;
    let removed = 0;
    const signal = {
      aborted: false,
      addEventListener(type: string) {
        if (type === 'abort') added += 1;
      },
      removeEventListener(type: string) {
        if (type === 'abort') removed += 1;
      },
    };

    const submission = coord.submit('prompt', { signal: signal as unknown as AbortSignal });
    expect(added).toBe(1);
    await submission.result.catch(() => undefined);
    expect(removed).toBe(1);
    expect(coord.activeRequestCount).toBe(0);
  });

  it('preserves timeoutMs=0 as the existing immediate-deadline value', async () => {
    const repo = new CountingRepository();
    const coord = coordinator(repo);

    const submission = coord.submit('prompt', { timeoutMs: 0 });
    expect(coord.getRequestRecord(submission.requestId)?.timeoutMs).toBe(0);
    await submission.result.catch(() => undefined);
    expect(coord.activeRequestCount).toBe(0);
  });
});
