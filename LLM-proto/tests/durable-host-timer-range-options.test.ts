import { describe, expect, it, vi } from 'vitest';
import {
  DurableCoordinator,
  type DurableCoordinatorOptions,
  type DurableSegmentExecutor,
} from '../src/durable-coordinator.js';
import { InMemoryRepository } from '../src/durable-repository.js';
import { ErrorCode, UnzenError } from '../src/errors.js';
import type { IdempotencyKey } from '../src/ids.js';
import { createFixtureModelManifest } from '../src/model-manifest-fixtures.js';
import { MAX_TIMER_DELAY_MS } from '../src/pipeline-utils.js';
import type { InferenceRequestId } from '../src/types.js';

const executor: DurableSegmentExecutor = {
  async execute() {
    throw new Error('executor must not run during timer preflight');
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

function construct(
  options: Partial<DurableCoordinatorOptions>,
  repository = new CountingRepository(),
): DurableCoordinator {
  return new DurableCoordinator(
    executor,
    createFixtureModelManifest({ totalSegments: 1 }),
    { allowFixtureManifest: true, ...options },
    repository,
  );
}

describe('DurableCoordinator host timer range preflight', () => {
  const timerBacked = [
    'heartbeatIntervalMs',
    'segmentTimeoutMs',
    'retryDelayMs',
    'checkpointCleanupIntervalMs',
    'recoveryOwnershipRenewIntervalMs',
    'recoveryPollIntervalMs',
  ] as const;

  it.each(timerBacked)(
    'accepts maximum representable %s and rejects one millisecond above it',
    (field) => {
      expect(() => construct({ [field]: MAX_TIMER_DELAY_MS })).not.toThrow();
      expect(() => construct({ [field]: MAX_TIMER_DELAY_MS + 1 })).toThrow(
        new RegExp(`DurableCoordinator ${field} must not exceed ${MAX_TIMER_DELAY_MS}ms`, 'i'),
      );
    },
  );

  it.each([
    'heartbeatTimeoutMs',
    'leaseTtlMs',
    'checkpointTtlMs',
    'cancelAckDeadlineMs',
    'recoveryOwnershipTtlMs',
  ] as const)(
    'does not impose the host timer range on comparison/deadline field %s',
    (field) => {
      expect(() => construct({ [field]: MAX_TIMER_DELAY_MS + 1 })).not.toThrow();
    },
  );

  it('rejects oversized submission timeout before idempotency, durable state, or timer creation', () => {
    const repo = new CountingRepository();
    const coord = construct({ maxRetries: 0, retryDelayMs: 0 }, repo);
    const timerSpy = vi.spyOn(globalThis, 'setTimeout');

    try {
      let thrown: unknown;
      try {
        coord.submit('prompt', {
          idempotencyKey: 'must-not-bind',
          timeoutMs: MAX_TIMER_DELAY_MS + 1,
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(UnzenError);
      expect((thrown as UnzenError).code).toBe(ErrorCode.ProtocolViolation);
      expect((thrown as Error).message).toBe(
        `submission timeoutMs must not exceed ${MAX_TIMER_DELAY_MS}ms`,
      );
      expect(repo.idempotencyReads).toBe(0);
      expect(repo.idempotencyWrites).toBe(0);
      expect(repo.listRequests()).toEqual([]);
      expect(coord.activeRequestCount).toBe(0);
      expect(timerSpy).not.toHaveBeenCalled();
    } finally {
      timerSpy.mockRestore();
    }
  });

  it('preserves timeoutMs=0 and the maximum representable submission timeout', async () => {
    for (const timeoutMs of [0, MAX_TIMER_DELAY_MS]) {
      const repo = new CountingRepository();
      const coord = construct({ maxRetries: 0, retryDelayMs: 0 }, repo);
      const submission = coord.submit('prompt', { timeoutMs });
      expect(coord.getRequestRecord(submission.requestId)?.timeoutMs).toBe(timeoutMs);
      await submission.result.catch(() => undefined);
      expect(coord.activeRequestCount).toBe(0);
    }
  });
});
