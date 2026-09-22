import { describe, expect, it } from 'vitest';
import {
  DurableCoordinator,
  type DurableSegmentExecutor,
} from '../src/durable-coordinator.js';
import { InMemoryRepository } from '../src/durable-repository.js';
import { ErrorCode, UnzenError } from '../src/errors.js';
import { idempotencyKey } from '../src/ids.js';
import { createFixtureModelManifest } from '../src/model-manifest-fixtures.js';

const executor: DurableSegmentExecutor = {
  execute: async () => {
    throw new Error('not used by submission-accessor boundary tests');
  },
};

function coordinator() {
  const repo = new InMemoryRepository();
  const coord = new DurableCoordinator(
    executor,
    createFixtureModelManifest({ totalSegments: 1 }),
    { allowFixtureManifest: true, maxRetries: 0, retryDelayMs: 0 },
    repo,
  );
  return { coord, repo };
}

function hostileThrownValue() {
  return {
    toString() {
      throw new Error('must not stringify caller-thrown value');
    },
    [Symbol.toPrimitive]() {
      throw new Error('must not coerce caller-thrown value');
    },
  };
}

function expectProtocolViolation(
  callback: () => unknown,
  expectedMessage: string,
) {
  try {
    callback();
    throw new Error('expected protocol violation');
  } catch (error) {
    expect(error).toBeInstanceOf(UnzenError);
    expect((error as UnzenError).code).toBe(ErrorCode.ProtocolViolation);
    expect((error as Error).message).toBe(expectedMessage);
  }
}

function expectNoDurableBinding(repo: InMemoryRepository) {
  expect(repo.listRequests()).toHaveLength(0);
  expect(repo.getIdempotencyMapping(idempotencyKey('must-not-bind'))).toBeUndefined();
}

describe('DurableCoordinator submission accessor boundary', () => {
  it('fails closed when a top-level submission option Proxy get trap throws', () => {
    for (const field of ['idempotencyKey', 'signal', 'timeoutMs'] as const) {
      const { coord, repo } = coordinator();
      const thrown = hostileThrownValue();
      const options = new Proxy<Record<string, unknown>>(
        { idempotencyKey: 'must-not-bind' },
        {
          get(target, property, receiver) {
            if (property === field) throw thrown;
            return Reflect.get(target, property, receiver);
          },
        },
      );

      expectProtocolViolation(
        () => coord.submit('prompt', options as never),
        `submission option ${field} could not be read`,
      );
      expectNoDurableBinding(repo);
    }
  });

  it('fails closed when a direct top-level submission option getter throws', () => {
    for (const field of ['idempotencyKey', 'signal', 'timeoutMs'] as const) {
      const { coord, repo } = coordinator();
      const thrown = hostileThrownValue();
      const options: Record<string, unknown> = { idempotencyKey: 'must-not-bind' };
      Object.defineProperty(options, field, {
        enumerable: true,
        configurable: true,
        get() {
          throw thrown;
        },
      });

      expectProtocolViolation(
        () => coord.submit('prompt', options as never),
        `submission option ${field} could not be read`,
      );
      expectNoDurableBinding(repo);
    }
  });

  it('fails closed before listener installation when an initial AbortSignal Proxy get trap throws', () => {
    for (const field of ['aborted', 'addEventListener', 'removeEventListener'] as const) {
      const { coord, repo } = coordinator();
      const thrown = hostileThrownValue();
      let addCalls = 0;
      let removeCalls = 0;
      const signal = new Proxy<Record<string, unknown>>(
        {
          aborted: false,
          addEventListener() {
            addCalls += 1;
          },
          removeEventListener() {
            removeCalls += 1;
          },
        },
        {
          get(target, property, receiver) {
            if (property === field) throw thrown;
            return Reflect.get(target, property, receiver);
          },
        },
      );

      expectProtocolViolation(
        () => coord.submit('prompt', {
          idempotencyKey: 'must-not-bind',
          signal: signal as unknown as AbortSignal,
        }),
        'submission signal must expose boolean aborted and event-listener methods',
      );
      expect(addCalls).toBe(0);
      expect(removeCalls).toBe(0);
      expectNoDurableBinding(repo);
    }
  });

  it('fails closed before listener installation when a direct initial AbortSignal getter throws', () => {
    for (const field of ['aborted', 'addEventListener', 'removeEventListener'] as const) {
      const { coord, repo } = coordinator();
      const thrown = hostileThrownValue();
      let addCalls = 0;
      let removeCalls = 0;
      const signal: Record<string, unknown> = {
        aborted: false,
        addEventListener() {
          addCalls += 1;
        },
        removeEventListener() {
          removeCalls += 1;
        },
      };
      Object.defineProperty(signal, field, {
        enumerable: true,
        configurable: true,
        get() {
          throw thrown;
        },
      });

      expectProtocolViolation(
        () => coord.submit('prompt', {
          idempotencyKey: 'must-not-bind',
          signal: signal as unknown as AbortSignal,
        }),
        'submission signal must expose boolean aborted and event-listener methods',
      );
      expect(addCalls).toBe(0);
      expect(removeCalls).toBe(0);
      expectNoDurableBinding(repo);
    }
  });
});
