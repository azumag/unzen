import { describe, expect, it } from 'vitest';
import {
  AdaptiveChunkDispatcher,
  type AdaptiveChunkDispatcherOptions,
} from '../src/adaptive-chunk-dispatcher.js';
import { makeSegments } from './test-helpers.js';

describe('AdaptiveChunkDispatcher runtime configuration validation', () => {
  it('rejects non-number configuredVramLimitMB values instead of coercing or defaulting them', () => {
    const malformedValues: readonly unknown[] = [
      '4200',
      'unbounded',
      true,
      false,
      null,
      {},
      [],
      Symbol('vram-limit'),
    ];

    for (const configuredVramLimitMB of malformedValues) {
      const options = {
        segments: makeSegments(1),
        configuredVramLimitMB,
      } as unknown as AdaptiveChunkDispatcherOptions;

      expect(() => new AdaptiveChunkDispatcher(options)).toThrow(
        'configuredVramLimitMB must be non-negative or positive infinity',
      );
    }
  });

  it.each([0, 4096, Number.POSITIVE_INFINITY])(
    'keeps documented configuredVramLimitMB boundary %s valid',
    (configuredVramLimitMB) => {
      expect(() => new AdaptiveChunkDispatcher({
        segments: makeSegments(1),
        configuredVramLimitMB,
      })).not.toThrow();
    },
  );
});
