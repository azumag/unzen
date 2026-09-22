import { describe, expect, it, vi } from 'vitest';
import { UnzenFunctionError, UnzenRuntimeError } from '@unzen/shared';
import { QuickJSRuntime } from '../src/quickjs-runtime';

function runtimeThrowingOnContextCreation(failure: unknown): QuickJSRuntime {
  const runtime = new QuickJSRuntime();
  Object.defineProperty(runtime, 'quickJS', {
    value: {
      newContext: vi.fn(() => {
        throw failure;
      }),
    },
    configurable: true,
  });
  return runtime;
}

function runtimeThrowingFromHost(failure: unknown): {
  runtime: QuickJSRuntime;
  dispose: ReturnType<typeof vi.fn>;
} {
  const dispose = vi.fn();
  const context = {
    runtime: {
      setMemoryLimit: vi.fn(() => {
        throw failure;
      }),
    },
    dispose,
  };
  const runtime = new QuickJSRuntime();
  Object.defineProperty(runtime, 'quickJS', {
    value: { newContext: vi.fn(() => context) },
    configurable: true,
  });
  return { runtime, dispose };
}

function revokedFailure(): object {
  const { proxy, revoke } = Proxy.revocable(new Error('hidden failure'), {});
  revoke();
  return proxy;
}

describe('QuickJSRuntime host/runtime error boundary', () => {
  it('fails closed when context creation throws a revoked value', async () => {
    const runtime = runtimeThrowingOnContextCreation(revokedFailure());

    await expect(runtime.execute('function run() { return 1; }', []))
      .rejects.toEqual(expect.objectContaining({
        name: 'UnzenFunctionError',
        message: 'Function execution failed: Unknown error',
      }));
  });

  it('fails closed on revoked host failures and still disposes the context', async () => {
    const { runtime, dispose } = runtimeThrowingFromHost(revokedFailure());

    await expect(runtime.execute('function run() { return 1; }', []))
      .rejects.toEqual(expect.objectContaining({
        name: 'UnzenFunctionError',
        message: 'Function execution failed: Unknown error',
      }));

    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('does not coerce hostile object/function failures', async () => {
    const toPrimitive = vi.fn(() => {
      throw new Error('Symbol.toPrimitive must not run');
    });
    const valueOf = vi.fn(() => {
      throw new Error('valueOf must not run');
    });
    const toString = vi.fn(() => {
      throw new Error('toString must not run');
    });
    const hostile = {
      [Symbol.toPrimitive]: toPrimitive,
      valueOf,
      toString,
    };
    const { runtime, dispose } = runtimeThrowingFromHost(hostile);

    await expect(runtime.execute('function run() { return 1; }', []))
      .rejects.toThrow('Function execution failed: Unknown error');

    expect(toPrimitive).not.toHaveBeenCalled();
    expect(valueOf).not.toHaveBeenCalled();
    expect(toString).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('keeps ordinary Error and primitive diagnostics useful', async () => {
    const errorCase = runtimeThrowingFromHost(new Error('ordinary host failure'));
    await expect(errorCase.runtime.execute('function run() { return 1; }', []))
      .rejects.toThrow('Function execution failed: ordinary host failure');
    expect(errorCase.dispose).toHaveBeenCalledTimes(1);

    const primitiveCase = runtimeThrowingFromHost('primitive host failure');
    await expect(primitiveCase.runtime.execute('function run() { return 1; }', []))
      .rejects.toThrow('Function execution failed: primitive host failure');
    expect(primitiveCase.dispose).toHaveBeenCalledTimes(1);
  });

  it('rethrows ordinary Unzen runtime/function errors by identity', async () => {
    const runtimeFailure = new UnzenRuntimeError('runtime failure');
    const runtimeCase = runtimeThrowingFromHost(runtimeFailure);
    await expect(runtimeCase.runtime.execute('function run() { return 1; }', []))
      .rejects.toBe(runtimeFailure);
    expect(runtimeCase.dispose).toHaveBeenCalledTimes(1);

    const functionFailure = new UnzenFunctionError('function failure');
    const functionCase = runtimeThrowingFromHost(functionFailure);
    await expect(functionCase.runtime.execute('function run() { return 1; }', []))
      .rejects.toBe(functionFailure);
    expect(functionCase.dispose).toHaveBeenCalledTimes(1);
  });
});
