import { describe, expect, it } from 'vitest';
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
  prompt: unknown,
): void {
  let thrown: unknown;
  try {
    coord.submit(prompt as never, { idempotencyKey: 'must-not-bind' });
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(UnzenError);
  expect((thrown as UnzenError).code).toBe(ErrorCode.ProtocolViolation);
  expect((thrown as Error).message).toBe('submission prompt must be a string');
  expect(repo.idempotencyReads).toBe(0);
  expect(repo.idempotencyWrites).toBe(0);
  expect(repo.listRequests()).toEqual([]);
  expect(coord.activeRequestCount).toBe(0);
}

describe('DurableCoordinator submission prompt runtime boundary', () => {
  it.each([
    null,
    undefined,
    42,
    true,
    [],
    {},
    Symbol('prompt'),
    () => undefined,
  ])('rejects malformed prompt %p before idempotency or durable mutation', (prompt) => {
    const repo = new CountingRepository();
    const coord = coordinator(repo);

    expectRejectedBeforeMutation(coord, repo, prompt);
  });

  it.each(['', '   ', 'prompt', '\n'])('preserves accepted string prompt exactly: %p', async (prompt) => {
    const repo = new CountingRepository();
    const coord = coordinator(repo);

    const submission = coord.submit(prompt);
    expect(coord.getRequestRecord(submission.requestId)?.prompt).toBe(prompt);

    await submission.result.catch(() => undefined);
    expect(coord.activeRequestCount).toBe(0);
  });
});
