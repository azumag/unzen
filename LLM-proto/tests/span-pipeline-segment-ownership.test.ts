import { describe, expect, it } from 'vitest';
import { SpanPipeline, type SpanExecutor } from '../src/span-pipeline.js';
import { CheckpointStore } from '../src/checkpoint.js';
import { WorkerPool } from '../src/worker-pool.js';
import {
  workerId,
  WorkerTier,
  type SegmentConfig,
} from '../src/types.js';
import type { SpanAssignment, SpanResult } from '../src/protocol.js';
import { makeCheckpoint, makeRequest, makeSegments } from './test-helpers.js';

function successfulExecutor(
  totalSegments: number,
  onExecute?: (assignment: SpanAssignment, callIndex: number) => void,
): SpanExecutor {
  let callIndex = 0;
  return {
    execute: async (assignedWorkerId, assignment): Promise<SpanResult> => {
      const currentCall = callIndex++;
      onExecute?.(assignment, currentCall);
      const firstSegment = assignment.segments[0];
      const lastSegment = assignment.segments[assignment.segments.length - 1];
      const isFinal = lastSegment.index === totalSegments - 1;
      return {
        requestId: assignment.requestId,
        workerId: assignedWorkerId,
        startSegment: firstSegment.index,
        endSegment: lastSegment.index,
        checkpoint: isFinal
          ? undefined
          : makeCheckpoint(assignment.requestId, lastSegment.index),
        output: isFinal ? { tokens: [7], text: 'stable snapshot' } : undefined,
        processingTimeMs: 1,
      };
    },
  };
}

describe('SpanPipeline segment ownership', () => {
  it('detaches segment membership and fields at construction', async () => {
    const segments = makeSegments(2);
    const originalFirst = { ...segments[0] };
    const pool = new WorkerPool();
    pool.register({
      workerId: workerId('all-segments'),
      tier: WorkerTier.TIER_1,
      vramMB: 4_200,
    });

    const assignments: SpanAssignment[] = [];
    const pipeline = new SpanPipeline(
      segments,
      pool,
      new CheckpointStore(),
      successfulExecutor(2, (assignment) => assignments.push(assignment)),
      { retryDelayMs: 0 },
    );

    // TypeScript readonly is not a runtime ownership boundary. Mutate the
    // original plain object deliberately to verify the pipeline retained its
    // detached snapshot rather than this caller-owned record.
    const mutableFirst = segments[0] as unknown as {
      estimatedVramMB: number;
      modelWeightHash: string;
    };
    mutableFirst.estimatedVramMB = 999_999;
    mutableFirst.modelWeightHash = 'sha256:mutated';
    segments.push(makeSegments(3)[2]);

    const result = await pipeline.run(makeRequest(2, 0, 'snapshot-before-run'));

    expect(result.segmentsCompleted).toBe(2);
    expect(assignments).toHaveLength(1);
    expect(assignments[0].segments).toHaveLength(2);
    expect(assignments[0].segments[0]).toStrictEqual(originalFirst);
    expect(assignments[0].segments[0]).not.toBe(segments[0]);
  });

  it('keeps later assignments stable when the caller mutates the source array during execution', async () => {
    const segments = makeSegments(2);
    const pool = new WorkerPool();
    pool.register({ workerId: workerId('w1'), tier: WorkerTier.TIER_2, vramMB: 2_100 });
    pool.register({ workerId: workerId('w2'), tier: WorkerTier.TIER_2, vramMB: 2_100 });

    const seenSegmentIndexes: number[][] = [];
    const pipeline = new SpanPipeline(
      segments,
      pool,
      new CheckpointStore(),
      successfulExecutor(2, (assignment, callIndex) => {
        seenSegmentIndexes.push(assignment.segments.map((segment) => segment.index));
        if (callIndex === 0) {
          segments.splice(1, 1);
          segments[0] = {
            ...segments[0],
            index: 99,
          } as SegmentConfig;
        }
      }),
      { retryDelayMs: 0 },
    );

    const result = await pipeline.run(makeRequest(2, 0, 'snapshot-during-run'));

    expect(seenSegmentIndexes).toStrictEqual([[0], [1]]);
    expect(result.segmentsCompleted).toBe(2);
    expect(result.text).toBe('stable snapshot');
  });

  it('captures array membership without consulting a caller-overridden iterator', () => {
    const segments = makeSegments(2);
    Object.defineProperty(segments, Symbol.iterator, {
      value: () => {
        throw new Error('iterator must not run');
      },
      configurable: true,
    });

    expect(() => new SpanPipeline(
      segments,
      new WorkerPool(),
      new CheckpointStore(),
      successfulExecutor(2),
    )).not.toThrow();
  });
});
