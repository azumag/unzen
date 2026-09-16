import { describe, expect, it, vi } from 'vitest';
import { CheckpointStore } from '../src/checkpoint.js';
import { Coordinator, type CoordinatorOptions } from '../src/coordinator.js';
import { createFixtureModelManifest } from '../src/model-manifest-fixtures.js';
import {
  Pipeline,
  type PipelineOptions,
  type SegmentExecutor,
} from '../src/pipeline.js';
import { MAX_TIMER_DELAY_MS } from '../src/pipeline-utils.js';
import { WorkerPool } from '../src/worker-pool.js';

function makeExecutor(): SegmentExecutor {
  return {
    execute: vi.fn(async () => {
      throw new Error('executor must not run during timer option preflight');
    }),
  };
}

function constructPipeline(options: Partial<PipelineOptions>): Pipeline {
  return new Pipeline(
    [],
    new WorkerPool(),
    new CheckpointStore(),
    makeExecutor(),
    options,
  );
}

function constructCoordinator(options: Partial<CoordinatorOptions>): Coordinator {
  return new Coordinator(
    makeExecutor(),
    createFixtureModelManifest({ totalSegments: 1 }),
    {
      allowFixtureManifest: true,
      ...options,
    },
  );
}

describe('legacy host timer option range preflight', () => {
  it.each(['segmentTimeoutMs', 'retryDelayMs'] as const)(
    'Pipeline accepts the maximum representable %s and rejects one millisecond above it',
    (field) => {
      expect(() => constructPipeline({ [field]: MAX_TIMER_DELAY_MS })).not.toThrow();
      expect(() => constructPipeline({ [field]: MAX_TIMER_DELAY_MS + 1 })).toThrow(
        new RegExp(`Pipeline ${field} must not exceed ${MAX_TIMER_DELAY_MS}ms`, 'i'),
      );
    },
  );

  it.each(['heartbeatIntervalMs', 'segmentTimeoutMs', 'retryDelayMs'] as const)(
    'Coordinator accepts the maximum representable %s and rejects one millisecond above it',
    (field) => {
      expect(() => constructCoordinator({ [field]: MAX_TIMER_DELAY_MS })).not.toThrow();
      expect(() => constructCoordinator({ [field]: MAX_TIMER_DELAY_MS + 1 })).toThrow(
        new RegExp(`Coordinator ${field} must not exceed ${MAX_TIMER_DELAY_MS}ms`, 'i'),
      );
    },
  );

  it('does not constrain comparison-only heartbeatTimeoutMs to the host timer range', () => {
    expect(() => constructCoordinator({
      heartbeatTimeoutMs: MAX_TIMER_DELAY_MS + 1,
    })).not.toThrow();
  });

  it('preserves zero timer controls', () => {
    expect(() => constructPipeline({
      segmentTimeoutMs: 0,
      retryDelayMs: 0,
    })).not.toThrow();
    expect(() => constructCoordinator({
      heartbeatIntervalMs: 0,
      segmentTimeoutMs: 0,
      retryDelayMs: 0,
    })).not.toThrow();
  });
});