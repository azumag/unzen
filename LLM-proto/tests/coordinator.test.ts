import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Coordinator } from '../src/coordinator.js';
import { createFixtureModelManifest } from '../src/model-manifest-fixtures.js';
import { workerId, WorkerTier } from '../src/types.js';
import type { SegmentExecutor } from '../src/pipeline.js';
import type { WorkerId, Checkpoint } from '../src/types.js';
import type { SegmentAssignment, SegmentResult } from '../src/protocol.js';
import { inferenceRequestId } from '../src/types.js';

/**
 * Mock executor factory: returns an executor that successfully processes
 * all segments. Intermediate segments produce checkpoints,
 * the final segment produces output tokens.
 */
function createMockExecutor(totalSegments: number): SegmentExecutor {
  return {
    execute: async (_workerId: WorkerId, assignment: SegmentAssignment): Promise<SegmentResult> => {
      const isFinal = assignment.segment.index === totalSegments - 1;
      return {
        requestId: assignment.requestId,
        segmentIndex: assignment.segment.index,
        workerId: _workerId,
        checkpoint: isFinal ? undefined : {
          requestId: assignment.requestId,
          segmentIndex: assignment.segment.index,
          hiddenStates: new Uint8Array([assignment.segment.index]),
          metadata: {
            shape: [1, 128, 4096],
            dtype: 'float16',
            sequenceLength: 128,
            timestamp: Date.now(),
          },
        },
        output: isFinal ? { tokens: [100, 200], text: 'test output' } : undefined,
        processingTimeMs: 100,
      };
    },
  };
}

describe('Coordinator', () => {
  let coordinator: Coordinator;
  const totalSegments = 4;

  beforeEach(() => {
    vi.useFakeTimers();
    coordinator = new Coordinator(
      createMockExecutor(totalSegments),
      createFixtureModelManifest({ totalSegments }),
      {
        totalSegments,
        heartbeatTimeoutMs: 10_000,
        heartbeatIntervalMs: 5_000,
        retryDelayMs: 0,
        allowFixtureManifest: true,
      },
    );
  });

  afterEach(() => {
    coordinator.stopHeartbeatMonitor();
    vi.useRealTimers();
  });

  describe('worker management', () => {
    it('should register workers', () => {
      coordinator.registerWorker({
        workerId: workerId('w1'),
        tier: WorkerTier.TIER_2,
        vramMB: 8192,
      });

      expect(coordinator.workerCount).toBe(1);
      expect(coordinator.idleWorkerCount).toBe(1);
    });

    it('should process heartbeats', () => {
      coordinator.registerWorker({
        workerId: workerId('w1'),
        tier: WorkerTier.TIER_3,
        vramMB: 8192,
      });

      expect(coordinator.workerHeartbeat(workerId('w1'))).toBe(true);
      expect(coordinator.workerHeartbeat(workerId('unknown'))).toBe(false);
    });

    it('should remove workers', () => {
      coordinator.registerWorker({
        workerId: workerId('w1'),
        tier: WorkerTier.TIER_3,
        vramMB: 8192,
      });

      coordinator.removeWorker(workerId('w1'));
      expect(coordinator.workerCount).toBe(0);
    });
  });

  describe('handleWorkerMessage', () => {
    it('should handle worker:register message', () => {
      coordinator.handleWorkerMessage({
        type: 'worker:register',
        payload: { workerId: workerId('w1'), tier: WorkerTier.TIER_2, vramMB: 8192 },
      });

      expect(coordinator.workerCount).toBe(1);
    });

    it('should respond to heartbeat with ack', () => {
      coordinator.registerWorker({
        workerId: workerId('w1'),
        tier: WorkerTier.TIER_3,
        vramMB: 8192,
      });

      const response = coordinator.handleWorkerMessage({
        type: 'worker:heartbeat',
        payload: { workerId: workerId('w1'), timestamp: Date.now() },
      });

      expect(response).not.toBeNull();
      expect(response?.type).toBe('heartbeat:ack');
    });
  });

  describe('inference request', () => {
    it('should complete a full inference pipeline', async () => {
      // Register workers for each segment
      for (let i = 0; i < totalSegments; i++) {
        coordinator.registerWorker({
          workerId: workerId(`w${i}`),
          tier: WorkerTier.TIER_3,
          vramMB: 8192,
        });
      }

      const result = await coordinator.submitRequest('Hello, world!');

      expect(result.text).toBe('test output');
      expect(result.tokens).toEqual([100, 200]);
      expect(result.segmentsCompleted).toBe(totalSegments);
      expect(result.totalTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('should track active request count', async () => {
      coordinator.registerWorker({
        workerId: workerId('w1'),
        tier: WorkerTier.TIER_3,
        vramMB: 8192,
      });

      expect(coordinator.activeRequestCount).toBe(0);

      // submitRequest is async; it resolves only after pipeline completes
      const promise = coordinator.submitRequest('test');
      // activeRequestCount should be 1 during execution
      // (though this is hard to observe in sync test)
      await promise;

      expect(coordinator.activeRequestCount).toBe(0);
    });

    it('should clean up checkpoints after completion', async () => {
      coordinator.registerWorker({
        workerId: workerId('w1'),
        tier: WorkerTier.TIER_3,
        vramMB: 8192,
      });

      await coordinator.submitRequest('test');
      expect(coordinator.checkpointCount).toBe(0);
    });

    it('should throw when no workers are available', async () => {
      await expect(coordinator.submitRequest('test'))
        .rejects.toThrow();
    });
  });

  describe('model manifest injection', () => {
    it('derives segment geometry from the validated manifest', () => {
      const manifest = createFixtureModelManifest({ totalSegments: 4 });
      const derived = new Coordinator(createMockExecutor(4), manifest, {
        heartbeatTimeoutMs: 10_000,
        heartbeatIntervalMs: 5_000,
        retryDelayMs: 0,
        allowFixtureManifest: true,
      });

      expect(derived.segmentCount).toBe(4);
      expect(derived.modelRevision).toBe(manifest.modelRevision);
      expect(derived.manifestDigest).toBe(manifest.manifestDigest);
    });

    it('rejects a fixture manifest by default (production code path)', () => {
      expect(() => new Coordinator(
        createMockExecutor(4),
        createFixtureModelManifest({ totalSegments: 4 }),
        {
          heartbeatTimeoutMs: 10_000,
          heartbeatIntervalMs: 5_000,
          retryDelayMs: 0,
        },
      )).toThrow(/fixture/);
    });

    it('rejects an invalid manifest even when fixtures are allowed', () => {
      const manifest = createFixtureModelManifest({ totalSegments: 4 });
      const broken = {
        ...manifest,
        segments: manifest.segments.map((segment, index) =>
          index === 1 ? { ...segment, sha256: 'sha256:segment-1' } : segment,
        ),
      };

      expect(() => new Coordinator(createMockExecutor(4), broken, {
        heartbeatTimeoutMs: 10_000,
        heartbeatIntervalMs: 5_000,
        retryDelayMs: 0,
        allowFixtureManifest: true,
      })).toThrow(/placeholder/);
    });

    it('rejects a segment count that disagrees with Coordinator options', () => {
      expect(() => new Coordinator(
        createMockExecutor(4),
        createFixtureModelManifest({ totalSegments: 4 }),
        {
          totalSegments: 8,
          heartbeatTimeoutMs: 10_000,
          heartbeatIntervalMs: 5_000,
          retryDelayMs: 0,
          allowFixtureManifest: true,
        },
      )).toThrow(/segments/);
    });
  });

  describe('heartbeat monitor', () => {
    it('should detect timed-out workers', () => {
      coordinator.registerWorker({
        workerId: workerId('w1'),
        tier: WorkerTier.TIER_3,
        vramMB: 8192,
      });

      coordinator.startHeartbeatMonitor();

      // Advance time past the timeout
      vi.advanceTimersByTime(20_000);

      // Worker should now be disconnected (idle count drops)
      expect(coordinator.idleWorkerCount).toBe(0);
    });

    it('should not disconnect workers that send heartbeats', () => {
      coordinator.registerWorker({
        workerId: workerId('w1'),
        tier: WorkerTier.TIER_3,
        vramMB: 8192,
      });

      coordinator.startHeartbeatMonitor();

      // Send heartbeats at regular intervals
      vi.advanceTimersByTime(4_000);
      coordinator.workerHeartbeat(workerId('w1'));
      vi.advanceTimersByTime(4_000);
      coordinator.workerHeartbeat(workerId('w1'));
      vi.advanceTimersByTime(4_000);

      expect(coordinator.idleWorkerCount).toBe(1);
    });
  });
});
