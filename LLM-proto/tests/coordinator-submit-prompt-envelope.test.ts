import { describe, expect, it, vi } from 'vitest';
import { Coordinator } from '../src/coordinator.js';
import { createFixtureModelManifest } from '../src/model-manifest-fixtures.js';
import type { SegmentExecutor } from '../src/pipeline.js';
import type { SegmentAssignment, SegmentResult } from '../src/protocol.js';
import { workerId, WorkerTier, type WorkerId } from '../src/types.js';

function createCoordinator() {
  const execute = vi.fn(
    async (assignedWorkerId: WorkerId, assignment: SegmentAssignment): Promise<SegmentResult> => ({
      requestId: assignment.requestId,
      segmentIndex: assignment.segment.index,
      workerId: assignedWorkerId,
      output: { tokens: [1], text: 'ok' },
      processingTimeMs: 1,
    }),
  );
  const executor: SegmentExecutor = { execute };
  const coordinator = new Coordinator(
    executor,
    createFixtureModelManifest({ totalSegments: 1 }),
    {
      allowFixtureManifest: true,
      totalSegments: 1,
      maxRetries: 0,
      retryDelayMs: 0,
    },
  );
  return { coordinator, execute };
}

describe('Coordinator submitRequest prompt runtime envelope', () => {
  it('rejects malformed prompts before request identity/state or executor side effects', async () => {
    const { coordinator, execute } = createCoordinator();
    const malformed: readonly unknown[] = [
      null,
      undefined,
      {},
      [],
      1,
      true,
      Symbol('prompt'),
    ];

    for (const prompt of malformed) {
      await expect(coordinator.submitRequest(prompt as string)).rejects.toThrow(
        /prompt must be a string/i,
      );
      expect(coordinator.activeRequestCount).toBe(0);
      expect(coordinator.checkpointCount).toBe(0);
      expect(execute).not.toHaveBeenCalled();
    }

    // Invalid submissions must not consume request identity. The first valid
    // submission still receives req-1 and retains existing empty-string semantics.
    coordinator.registerWorker({
      workerId: workerId('prompt-worker'),
      tier: WorkerTier.TIER_3,
      vramMB: 8192,
    });
    const result = await coordinator.submitRequest('');
    expect(result.requestId).toBe('req-1');
    expect(result.text).toBe('ok');
    expect(coordinator.activeRequestCount).toBe(0);
    expect(execute).toHaveBeenCalledOnce();
  });

  it('preserves whitespace-only string submissions', async () => {
    const { coordinator, execute } = createCoordinator();
    coordinator.registerWorker({
      workerId: workerId('prompt-worker'),
      tier: WorkerTier.TIER_3,
      vramMB: 8192,
    });

    const result = await coordinator.submitRequest('   ');
    expect(result.requestId).toBe('req-1');
    expect(execute).toHaveBeenCalledOnce();
  });
});
