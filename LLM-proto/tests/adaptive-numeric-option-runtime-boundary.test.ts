import { describe, expect, it } from 'vitest';
import {
  AdaptiveChunkDispatcher,
  type AdaptiveChunkDispatcherOptions,
} from '../src/adaptive-chunk-dispatcher.js';
import { makeSegments } from './test-helpers.js';

const numericOptions = [
  'loadBudgetRatio',
  'longLivedWorkerMs',
  'configuredVramLimitMB',
  'checkpointBytes',
] as const;

describe('AdaptiveChunkDispatcher numeric option runtime boundary', () => {
  it.each(numericOptions)(
    'bounds a throwing %s accessor without coercing the thrown value',
    (field) => {
      let coercions = 0;
      const hostileThrownValue = {
        [Symbol.toPrimitive]() {
          coercions += 1;
          throw new Error('must not coerce');
        },
        valueOf() {
          coercions += 1;
          throw new Error('must not valueOf');
        },
        toString() {
          coercions += 1;
          throw new Error('must not stringify');
        },
      };
      const options = {
        segments: makeSegments(1),
      } as AdaptiveChunkDispatcherOptions;
      Object.defineProperty(options, field, {
        configurable: true,
        get() {
          throw hostileThrownValue;
        },
      });

      expect(() => new AdaptiveChunkDispatcher(options)).toThrow(
        new RegExp(`AdaptiveChunkDispatcher ${field} could not be read`),
      );
      expect(coercions).toBe(0);
    },
  );

  it.each([
    ['loadBudgetRatio', 0.5],
    ['longLivedWorkerMs', 1_000],
    ['configuredVramLimitMB', 4_096],
    ['checkpointBytes', 1_024],
  ] as const)(
    'keeps a valid explicit %s accessor read-once after hardening',
    (field, value) => {
      let reads = 0;
      const options = {
        segments: makeSegments(1),
      } as AdaptiveChunkDispatcherOptions;
      Object.defineProperty(options, field, {
        configurable: true,
        get() {
          reads += 1;
          return value;
        },
      });

      expect(() => new AdaptiveChunkDispatcher(options)).not.toThrow();
      expect(reads).toBe(1);
    },
  );

  it.each(numericOptions)(
    'keeps an omitted/defaulted %s accessor read-once after hardening',
    (field) => {
      let reads = 0;
      const options = {
        segments: makeSegments(1),
      } as AdaptiveChunkDispatcherOptions;
      Object.defineProperty(options, field, {
        configurable: true,
        get() {
          reads += 1;
          return undefined;
        },
      });

      expect(() => new AdaptiveChunkDispatcher(options)).not.toThrow();
      expect(reads).toBe(1);
    },
  );
});
