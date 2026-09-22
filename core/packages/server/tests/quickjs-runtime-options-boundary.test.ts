import { describe, expect, it, vi } from 'vitest';
import { QuickJSRuntime } from '../src/quickjs-runtime';

function runtimeWithContextSpy(): {
  runtime: QuickJSRuntime;
  newContext: ReturnType<typeof vi.fn>;
} {
  const runtime = new QuickJSRuntime();
  const newContext = vi.fn();
  Object.defineProperty(runtime, 'quickJS', {
    value: { newContext },
    configurable: true,
  });
  return { runtime, newContext };
}

describe('QuickJSRuntime execution options runtime boundary', () => {
  it('fails closed on a revoked options Proxy before allocating a context', async () => {
    const { runtime, newContext } = runtimeWithContextSpy();
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();

    await expect(runtime.execute(
      'function run() { return 1; }',
      [],
      revoked.proxy as never,
    )).rejects.toThrow('QuickJS execution options must be an object');

    expect(newContext).not.toHaveBeenCalled();
  });

  it('keeps caller-thrown option values opaque and rejects before context allocation', async () => {
    const { runtime, newContext } = runtimeWithContextSpy();
    const hostileThrownValue = {
      toString() {
        throw new Error('caller value must not be stringified');
      },
      [Symbol.toPrimitive]() {
        throw new Error('caller value must not be coerced');
      },
    };
    const options = new Proxy({}, {
      get(_target, property) {
        if (property === 'timeout') throw hostileThrownValue;
        return undefined;
      },
    });

    await expect(runtime.execute(
      'function run() { return 1; }',
      [],
      options,
    )).rejects.toThrow('QuickJS execution options could not be read');

    expect(newContext).not.toHaveBeenCalled();
  });

  it('preserves the normal array rejection diagnostic', async () => {
    const { runtime, newContext } = runtimeWithContextSpy();

    await expect(runtime.execute(
      'function run() { return 1; }',
      [],
      [] as never,
    )).rejects.toThrow('QuickJS execution options must be an object');

    expect(newContext).not.toHaveBeenCalled();
  });

  it('fails closed on revoked arguments before allocating a context', async () => {
    const { runtime, newContext } = runtimeWithContextSpy();
    const revoked = Proxy.revocable([], {});
    revoked.revoke();

    await expect(runtime.execute(
      'function run() { return 1; }',
      revoked.proxy as never,
    )).rejects.toThrow('QuickJS arguments must be an array');

    expect(newContext).not.toHaveBeenCalled();
  });
});
