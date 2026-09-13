import { describe, expect, it } from 'vitest';
import { DurableCoordinator } from '../src/durable-coordinator.js';
import type { DurableSegmentExecutor } from '../src/durable-coordinator.js';
import { InMemoryRepository } from '../src/durable-repository.js';
import { createFixtureModelManifest } from '../src/model-manifest-fixtures.js';

const executor: DurableSegmentExecutor = {
  async execute() {
    throw new Error('executor should not run');
  },
};

function coordinator(repo: InMemoryRepository): DurableCoordinator {
  return new DurableCoordinator(
    executor,
    createFixtureModelManifest({ totalSegments: 1 }),
    { allowFixtureManifest: true },
    repo,
  );
}

describe('DurableCoordinator caller idempotency-key boundary', () => {
  it.each([null, 42, true, {}, [], Symbol('key'), '', '   '])(
    'rejects malformed idempotency key %p before durable request creation',
    (idempotencyKey) => {
      const repo = new InMemoryRepository();
      const coord = coordinator(repo);

      expect(() => coord.submit('prompt', { idempotencyKey } as never)).toThrow(
        'idempotencyKey must be a non-empty string',
      );
      expect(repo.listRequests()).toEqual([]);
    },
  );
});
