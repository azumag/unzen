import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DurableCoordinator,
  type DurableSegmentExecutor,
} from '../src/durable-coordinator.js';
import { InMemoryRepository } from '../src/durable-repository.js';
import { generateRequestId } from '../src/ids.js';
import { createFixtureModelManifest } from '../src/model-manifest-fixtures.js';
import { MAX_TIMER_DELAY_MS } from '../src/pipeline-utils.js';
import type { ExecutionResult, ResultIdentity } from '../src/durable-types.js';
import { workerId, WorkerTier } from '../src/types.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DurableCoordinator legacy long-deadline recovery', () => {
  it('preserves an oversized persisted deadline while only arming bounded host timers', async () => {
    const manifest = createFixtureModelManifest({ totalSegments: 1 });
    const repo = new InMemoryRepository();
    const requestId = generateRequestId();
    const legacyTimeoutMs = MAX_TIMER_DELAY_MS + 60_000;
    repo.createRequest({
      requestId,
      prompt: 'legacy persisted request',
      stage: 'queued',
      createdAt: Date.now(),
      currentSegment: 0,
      totalSegments: manifest.segments.length,
      manifestDigest: manifest.manifestDigest,
      retryCount: 0,
      timeoutMs: legacyTimeoutMs,
    });

    const executor: DurableSegmentExecutor = {
      async execute(_workerId, assignment): Promise<ExecutionResult> {
        const identity: ResultIdentity = {
          requestId: assignment.requestId,
          attemptId: assignment.attemptId,
          leaseId: assignment.leaseId,
          workerId: assignment.workerId,
          workerGeneration: assignment.workerGeneration,
          segmentIndex: assignment.segmentIndex,
        };
        return {
          identity,
          output: { tokens: [7], text: 'legacy recovered' },
          processingTimeMs: 1,
        };
      },
    };
    const coordinator = new DurableCoordinator(
      executor,
      manifest,
      {
        allowFixtureManifest: true,
        maxRetries: 0,
        retryDelayMs: 0,
        segmentTimeoutMs: 5_000,
        leaseTtlMs: 100,
        recoveryOwnershipTtlMs: 1_000,
        recoveryOwnershipRenewIntervalMs: 250,
        recoveryPollIntervalMs: 5,
      },
      repo,
    );
    coordinator.registerWorker(
      { workerId: workerId('legacy-deadline-worker'), tier: WorkerTier.TIER_3, vramMB: 16_384 },
      'legacy-deadline-connection',
    );
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    const [submission] = coordinator.recoverPendingRequests();
    await expect(submission!.result).resolves.toMatchObject({ text: 'legacy recovered' });

    expect(repo.getRequest(requestId)?.timeoutMs).toBe(legacyTimeoutMs);
    expect(timeoutSpy.mock.calls.some((call) => call[1] === MAX_TIMER_DELAY_MS)).toBe(true);
    for (const call of timeoutSpy.mock.calls) {
      if (typeof call[1] === 'number') {
        expect(call[1]).toBeLessThanOrEqual(MAX_TIMER_DELAY_MS);
      }
    }
  });
});
