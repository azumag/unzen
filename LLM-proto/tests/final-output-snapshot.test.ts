import { describe, expect, it } from 'vitest';
import { Pipeline, type SegmentExecutor } from '../src/pipeline.js';
import { SpanPipeline, type SpanExecutor } from '../src/span-pipeline.js';
import { WorkerPool } from '../src/worker-pool.js';
import { CheckpointStore } from '../src/checkpoint.js';
import {
  workerId,
  WorkerTier,
} from '../src/types.js';
import type { SegmentResult, SpanResult } from '../src/protocol.js';
import { makeRequest, makeSegments } from './test-helpers.js';

function makeWorkerPool(id: string): WorkerPool {
  const pool = new WorkerPool();
  pool.register({
    workerId: workerId(id),
    tier: WorkerTier.TIER_2,
    vramMB: 4_200,
  });
  return pool;
}

describe('pipeline final output ownership', () => {
  it('captures basic Pipeline result.output and output.tokens exactly once', async () => {
    const pool = makeWorkerPool('final-output-basic-accessor');
    let outputReads = 0;
    let tokenReads = 0;
    const stableTokens = [31, 32];
    const stableOutput = {
      get tokens() {
        tokenReads++;
        return tokenReads === 1 ? stableTokens : [999];
      },
      text: 'stable-basic',
    };
    const executor: SegmentExecutor = {
      execute: async (assignedWorkerId, assignment) => ({
        requestId: assignment.requestId,
        segmentIndex: assignment.segment.index,
        workerId: assignedWorkerId,
        get output() {
          outputReads++;
          return outputReads === 1 ? stableOutput : { tokens: [999], text: 'changed' };
        },
        processingTimeMs: 1,
      } as unknown as SegmentResult),
    };
    const pipeline = new Pipeline(
      makeSegments(1),
      pool,
      new CheckpointStore(),
      executor,
      { retryDelayMs: 0 },
    );

    const result = await pipeline.run(makeRequest(1, 0, 'basic-output-accessor'));

    expect(result.tokens).toEqual([31, 32]);
    expect(result.text).toBe('stable-basic');
    expect(outputReads).toBe(1);
    expect(tokenReads).toBe(1);
  });

  it('detaches basic Pipeline tokens without using a worker-owned iterator', async () => {
    const pool = makeWorkerPool('final-output-basic-array');
    const sourceTokens = [41, 42];
    Object.defineProperty(sourceTokens, Symbol.iterator, {
      value: () => {
        throw new Error('worker token iterator must not run');
      },
    });
    const executor: SegmentExecutor = {
      execute: async (assignedWorkerId, assignment) => ({
        requestId: assignment.requestId,
        segmentIndex: assignment.segment.index,
        workerId: assignedWorkerId,
        output: { tokens: sourceTokens, text: 'owned-basic' },
        processingTimeMs: 1,
      }),
    };
    const pipeline = new Pipeline(
      makeSegments(1),
      pool,
      new CheckpointStore(),
      executor,
      { retryDelayMs: 0 },
    );

    const result = await pipeline.run(makeRequest(1, 0, 'basic-output-array'));
    const returnedTokens = result.tokens;

    expect(returnedTokens).not.toBe(sourceTokens);
    expect(returnedTokens[0]).toBe(41);
    expect(returnedTokens[1]).toBe(42);
    sourceTokens[0] = 777;
    expect(returnedTokens[0]).toBe(41);
  });

  it('captures SpanPipeline result.output and output.tokens exactly once', async () => {
    const pool = makeWorkerPool('final-output-span-accessor');
    let outputReads = 0;
    let tokenReads = 0;
    const stableTokens = [51, 52];
    const stableOutput = {
      get tokens() {
        tokenReads++;
        return tokenReads === 1 ? stableTokens : [999];
      },
      text: 'stable-span',
    };
    const executor: SpanExecutor = {
      execute: async (assignedWorkerId, assignment) => ({
        requestId: assignment.requestId,
        startSegment: assignment.segments[0].index,
        endSegment: assignment.segments[assignment.segments.length - 1].index,
        workerId: assignedWorkerId,
        get output() {
          outputReads++;
          return outputReads === 1 ? stableOutput : { tokens: [999], text: 'changed' };
        },
        processingTimeMs: 1,
      } as unknown as SpanResult),
    };
    const pipeline = new SpanPipeline(
      makeSegments(1),
      pool,
      new CheckpointStore(),
      executor,
      { retryDelayMs: 0 },
    );

    const result = await pipeline.run(makeRequest(1, 0, 'span-output-accessor'));

    expect(result.tokens).toEqual([51, 52]);
    expect(result.text).toBe('stable-span');
    expect(outputReads).toBe(1);
    expect(tokenReads).toBe(1);
  });

  it('detaches SpanPipeline tokens without using a worker-owned iterator', async () => {
    const pool = makeWorkerPool('final-output-span-array');
    const sourceTokens = [61, 62];
    Object.defineProperty(sourceTokens, Symbol.iterator, {
      value: () => {
        throw new Error('worker token iterator must not run');
      },
    });
    const executor: SpanExecutor = {
      execute: async (assignedWorkerId, assignment) => ({
        requestId: assignment.requestId,
        startSegment: assignment.segments[0].index,
        endSegment: assignment.segments[assignment.segments.length - 1].index,
        workerId: assignedWorkerId,
        output: { tokens: sourceTokens, text: 'owned-span' },
        processingTimeMs: 1,
      }),
    };
    const pipeline = new SpanPipeline(
      makeSegments(1),
      pool,
      new CheckpointStore(),
      executor,
      { retryDelayMs: 0 },
    );

    const result = await pipeline.run(makeRequest(1, 0, 'span-output-array'));
    const returnedTokens = result.tokens;

    expect(returnedTokens).not.toBe(sourceTokens);
    expect(returnedTokens[0]).toBe(61);
    expect(returnedTokens[1]).toBe(62);
    sourceTokens[0] = 888;
    expect(returnedTokens[0]).toBe(61);
  });
});
