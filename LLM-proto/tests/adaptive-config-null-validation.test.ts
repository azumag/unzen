import { describe, expect, it } from 'vitest';
import {
  AdaptiveChunkDispatcher,
  type AdaptiveChunkDispatcherOptions,
} from '../src/adaptive-chunk-dispatcher.js';
import { makeSegments } from './test-helpers.js';

describe('AdaptiveChunkDispatcher null runtime configuration validation', () => {
  it.each([
    ['loadBudgetRatio', /loadBudgetRatio/],
    ['longLivedWorkerMs', /longLivedWorkerMs/],
    ['checkpointBytes', /checkpointBytes/],
  ] as const)(
    'rejects explicit null for %s instead of silently applying the default',
    (field, expectedError) => {
      const options = {
        segments: makeSegments(1),
        [field]: null,
      } as unknown as AdaptiveChunkDispatcherOptions;

      expect(() => new AdaptiveChunkDispatcher(options)).toThrow(expectedError);
    },
  );

  it('still applies defaults when the optional numeric fields are omitted', () => {
    expect(() => new AdaptiveChunkDispatcher({
      segments: makeSegments(1),
    })).not.toThrow();
  });

  it('still treats explicit undefined as omitted for optional numeric fields', () => {
    expect(() => new AdaptiveChunkDispatcher({
      segments: makeSegments(1),
      loadBudgetRatio: undefined,
      longLivedWorkerMs: undefined,
      checkpointBytes: undefined,
    })).not.toThrow();
  });
});
