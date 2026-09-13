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
    { allowFixtureManifest: true },
    repo,
  );
}

describe('DurableCoordinator submission options runtime envelope', () => {
  it.each([null, 42, true, 'options', [], Symbol('options'), () => undefined])(
    'rejects malformed options container %p before durable or in-flight mutation',
    (options) => {
      const repo = new CountingRepository();
      const coord = coordinator(repo);

      let thrown: unknown;
      try {
        coord.submit('prompt', options as never);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(UnzenError);
      expect((thrown as UnzenError).code).toBe(ErrorCode.ProtocolViolation);
      expect((thrown as Error).message).toBe('submission options must be a non-null, non-array object');
      expect(repo.idempotencyReads).toBe(0);
      expect(repo.idempotencyWrites).toBe(0);
      expect(repo.listRequests()).toEqual([]);
      expect(coord.activeRequestCount).toBe(0);
    },
  );
});
