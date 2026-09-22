import { describe, expect, it, vi } from 'vitest';
import { createExecuteMessage, createInitMessage, type WorkerResponse } from '../src/worker/worker-protocol';
import { describeQuickJsWorkerFailure } from '../src/worker/quickjs-worker-error-boundary';
import { handleWorkerMessage, type WorkerState } from '../src/worker/quickjs-worker';

function revokedErrorProxy(): object {
  const { proxy, revoke } = Proxy.revocable(new Error('hidden'), {});
  revoke();
  return proxy;
}

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

describe('QuickJS worker host error boundary', () => {
  it('fails closed for revoked and hostile object diagnostics without coercion', () => {
    expect(describeQuickJsWorkerFailure(revokedErrorProxy())).toBe('Unknown error');

    const hostile = hostileObject();
    expect(describeQuickJsWorkerFailure(hostile.value)).toBe('Unknown error');
    expect(hostile.toPrimitive).not.toHaveBeenCalled();
    expect(hostile.valueOf).not.toHaveBeenCalled();
    expect(hostile.toString).not.toHaveBeenCalled();
  });

  it('keeps ordinary Error and primitive diagnostics useful', () => {
    expect(describeQuickJsWorkerFailure(new Error('ordinary failure'))).toBe('ordinary failure');
    expect(describeQuickJsWorkerFailure('string failure')).toBe('string failure');
    expect(describeQuickJsWorkerFailure(17)).toBe('17');
    expect(describeQuickJsWorkerFailure(null)).toBe('null');
  });

  it('settles a revoked loader rejection through the init protocol', async () => {
    const state: WorkerState = { quickJS: null };
    const responses: WorkerResponse[] = [];
    const loader = vi.fn().mockRejectedValue(revokedErrorProxy());

    await expect(handleWorkerMessage(
      { data: createInitMessage(1) },
      state,
      (message) => responses.push(message),
      loader,
    )).resolves.toBeUndefined();

    expect(responses).toEqual([
      expect.objectContaining({
        type: 'init-result',
        success: false,
        generationId: 1,
        error: 'Unknown error',
      }),
    ]);
    expect(state.quickJS).toBeNull();
  });

  it('keeps call-boundary read failures correlated as runtime errors', async () => {
    const args = new Proxy([] as unknown[], {
      get(target, property, receiver) {
        if (property === 'length') throw new Error('hostile args length');
        return Reflect.get(target, property, receiver);
      },
    });
    const state: WorkerState = { quickJS: null };
    const responses: WorkerResponse[] = [];

    await expect(handleWorkerMessage(
      { data: createExecuteMessage('req-hostile', 'function run() {}', args, 1) },
      state,
      (message) => responses.push(message),
    )).resolves.toBeUndefined();

    expect(responses).toEqual([
      expect.objectContaining({
        type: 'execute-result',
        requestId: 'req-hostile',
        success: false,
        errorType: 'runtime_error',
        error: 'QuickJS arguments could not be read',
      }),
    ]);
  });
});
