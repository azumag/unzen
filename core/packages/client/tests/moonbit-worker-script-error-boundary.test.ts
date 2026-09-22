import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createMoonbitExecuteMessage,
  type MoonbitWorkerResponse,
} from '../src/worker/moonbit-worker-protocol';
import {
  handleMoonbitWorkerMessage,
  type MoonbitWorkerState,
} from '../src/worker/moonbit-worker';

function hostileObject() {
  const toPrimitive = vi.fn(() => {
    throw new Error('Symbol.toPrimitive must not run');
  });
  const valueOf = vi.fn(() => {
    throw new Error('valueOf must not run');
  });
  const toString = vi.fn(() => {
    throw new Error('toString must not run');
  });
  return {
    value: {
      [Symbol.toPrimitive]: toPrimitive,
      valueOf,
      toString,
    },
    toPrimitive,
    valueOf,
    toString,
  };
}

function revokedErrorProxy(): object {
  const { proxy, revoke } = Proxy.revocable(new Error('hidden'), {});
  revoke();
  return proxy;
}

function cachedState(): MoonbitWorkerState {
  return {
    compiledModules: new Map([
      ['cached', {} as WebAssembly.Module],
    ]),
  };
}

function request(args: unknown[] = []) {
  return createMoonbitExecuteMessage(
    'req-boundary',
    'cached',
    new ArrayBuffer(0),
    true,
    'run',
    args,
    1,
  );
}

describe('MoonBit worker-script error boundary', () => {
  const originalInstantiate = WebAssembly.instantiate;

  afterEach(() => {
    (WebAssembly as unknown as { instantiate: typeof WebAssembly.instantiate }).instantiate =
      originalInstantiate;
    vi.restoreAllMocks();
  });

  it('fails closed when instantiate rejects with a revoked Proxy', async () => {
    (WebAssembly as unknown as { instantiate: typeof WebAssembly.instantiate }).instantiate =
      vi.fn().mockRejectedValue(revokedErrorProxy()) as unknown as typeof WebAssembly.instantiate;
    const responses: MoonbitWorkerResponse[] = [];

    await handleMoonbitWorkerMessage(
      { data: request() },
      cachedState(),
      (message) => responses.push(message),
    );

    expect(responses).toEqual([
      expect.objectContaining({
        type: 'execute-result',
        requestId: 'req-boundary',
        success: false,
        error: 'Failed to instantiate MoonBit module: Unknown error',
        errorType: 'runtime_error',
      }),
    ]);
  });

  it('does not coerce a hostile value thrown by the executed export', async () => {
    const hostile = hostileObject();
    (WebAssembly as unknown as { instantiate: typeof WebAssembly.instantiate }).instantiate =
      vi.fn().mockResolvedValue({
        exports: {
          run: () => {
            throw hostile.value;
          },
        },
      }) as unknown as typeof WebAssembly.instantiate;
    const responses: MoonbitWorkerResponse[] = [];

    await handleMoonbitWorkerMessage(
      { data: request() },
      cachedState(),
      (message) => responses.push(message),
    );

    expect(responses).toEqual([
      expect.objectContaining({
        type: 'execute-result',
        success: false,
        error: 'MoonBit function execution failed: Unknown error',
        errorType: 'function_error',
      }),
    ]);
    expect(hostile.toPrimitive).not.toHaveBeenCalled();
    expect(hostile.valueOf).not.toHaveBeenCalled();
    expect(hostile.toString).not.toHaveBeenCalled();
  });

  it('keeps ordinary Error and primitive export diagnostics useful', async () => {
    const thrownValues: Array<[unknown, string]> = [
      [new Error('ordinary failure'), 'ordinary failure'],
      ['string failure', 'string failure'],
      [17, '17'],
      [null, 'null'],
    ];

    for (const [thrown, expected] of thrownValues) {
      (WebAssembly as unknown as { instantiate: typeof WebAssembly.instantiate }).instantiate =
        vi.fn().mockResolvedValue({
          exports: {
            run: () => {
              throw thrown;
            },
          },
        }) as unknown as typeof WebAssembly.instantiate;
      const responses: MoonbitWorkerResponse[] = [];

      await handleMoonbitWorkerMessage(
        { data: request() },
        cachedState(),
        (message) => responses.push(message),
      );

      expect(responses[0]).toMatchObject({
        success: false,
        error: `MoonBit function execution failed: ${expected}`,
        errorType: 'function_error',
      });
    }
  });

  it('keeps call-boundary failures correlated without rereading hostile args', async () => {
    const args = new Proxy([] as unknown[], {
      get(target, property, receiver) {
        if (property === 'length') throw new Error('length trap must be contained');
        return Reflect.get(target, property, receiver);
      },
    });
    const responses: MoonbitWorkerResponse[] = [];

    await handleMoonbitWorkerMessage(
      { data: request(args) },
      cachedState(),
      (message) => responses.push(message),
    );

    expect(responses).toEqual([
      expect.objectContaining({
        type: 'execute-result',
        requestId: 'req-boundary',
        success: false,
        error: 'MoonBit arguments could not be read',
        errorType: 'runtime_error',
      }),
    ]);
  });
});
