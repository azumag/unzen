import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  UnzenCancelledError,
  UnzenFunctionError,
  UnzenNetworkError,
  UnzenRuntimeError,
} from '@unzen/shared';
import { MoonBitSandboxExecutor } from '../src/moonbit-sandbox';

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

function preparedModule() {
  return {
    url: 'https://example.com/test.wasm',
    module: {} as WebAssembly.Module,
  };
}

describe('MoonBitSandboxExecutor hostile rejection boundary', () => {
  const originalFetch = globalThis.fetch;
  const originalInstantiate = WebAssembly.instantiate;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    (WebAssembly as unknown as { instantiate: unknown }).instantiate = originalInstantiate;
    vi.restoreAllMocks();
  });

  it('fails closed when fetch rejects with a revoked Proxy', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(revokedErrorProxy()) as unknown as typeof fetch;
    const executor = new MoonBitSandboxExecutor();

    await expect(executor.prepare('https://example.com/revoked.wasm')).rejects.toMatchObject({
      name: 'UnzenNetworkError',
      message: 'Failed to fetch MoonBit module: Unknown error',
    });
    await expect(executor.prepare('https://example.com/revoked.wasm')).rejects.toBeInstanceOf(
      UnzenNetworkError,
    );
    executor.dispose();
  });

  it('does not coerce object/function rejection values while formatting fetch failures', async () => {
    const hostile = hostileObject();
    globalThis.fetch = vi.fn().mockRejectedValue(hostile.value) as unknown as typeof fetch;
    const executor = new MoonBitSandboxExecutor();

    await expect(executor.prepare('https://example.com/hostile.wasm')).rejects.toMatchObject({
      name: 'UnzenNetworkError',
      message: 'Failed to fetch MoonBit module: Unknown error',
    });
    expect(hostile.toPrimitive).not.toHaveBeenCalled();
    expect(hostile.valueOf).not.toHaveBeenCalled();
    expect(hostile.toString).not.toHaveBeenCalled();
    executor.dispose();
  });

  it('fails closed when the response body reader rejects with a hostile value', async () => {
    const hostile = hostileObject();
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      body: null,
      arrayBuffer: vi.fn().mockRejectedValue(hostile.value),
    }) as unknown as typeof fetch;
    const executor = new MoonBitSandboxExecutor();

    await expect(executor.prepare('https://example.com/body.wasm')).rejects.toMatchObject({
      name: 'UnzenNetworkError',
      message: 'Failed to read MoonBit module: Unknown error',
    });
    expect(hostile.toPrimitive).not.toHaveBeenCalled();
    expect(hostile.valueOf).not.toHaveBeenCalled();
    expect(hostile.toString).not.toHaveBeenCalled();
    executor.dispose();
  });

  it('fails closed when WebAssembly.instantiate rejects with a revoked Proxy', async () => {
    (WebAssembly as unknown as { instantiate: unknown }).instantiate = vi
      .fn()
      .mockRejectedValue(revokedErrorProxy());
    const executor = new MoonBitSandboxExecutor();

    await expect(executor.execute(preparedModule(), [])).rejects.toMatchObject({
      name: 'UnzenRuntimeError',
      message: 'Failed to instantiate MoonBit module: Unknown error',
    });
    await expect(executor.execute(preparedModule(), [])).rejects.toBeInstanceOf(
      UnzenRuntimeError,
    );
    executor.dispose();
  });

  it('preserves ordinary cancellation precedence during instantiation', async () => {
    (WebAssembly as unknown as { instantiate: unknown }).instantiate = vi
      .fn()
      .mockRejectedValue(new UnzenCancelledError('caller cancelled'));
    const executor = new MoonBitSandboxExecutor();

    await expect(executor.execute(preparedModule(), [])).rejects.toMatchObject({
      name: 'UnzenCancelledError',
      message: 'Execution was cancelled',
    });
    executor.dispose();
  });

  it('fails closed when a MoonBit export throws a hostile object', async () => {
    const hostile = hostileObject();
    (WebAssembly as unknown as { instantiate: unknown }).instantiate = vi.fn().mockResolvedValue({
      exports: {
        run: () => {
          throw hostile.value;
        },
      },
    } as unknown as WebAssembly.Instance);
    const executor = new MoonBitSandboxExecutor();

    await expect(executor.execute(preparedModule(), [])).rejects.toMatchObject({
      name: 'UnzenFunctionError',
      message: 'MoonBit function execution failed: Unknown error',
    });
    await expect(executor.execute(preparedModule(), [])).rejects.toBeInstanceOf(
      UnzenFunctionError,
    );
    expect(hostile.toPrimitive).not.toHaveBeenCalled();
    expect(hostile.valueOf).not.toHaveBeenCalled();
    expect(hostile.toString).not.toHaveBeenCalled();
    executor.dispose();
  });

  it.each([
    [new Error('offline'), 'offline'],
    ['offline', 'offline'],
    [42, '42'],
    [null, 'null'],
  ])('keeps useful diagnostics for ordinary fetch rejection %p', async (reason, detail) => {
    globalThis.fetch = vi.fn().mockRejectedValue(reason) as unknown as typeof fetch;
    const executor = new MoonBitSandboxExecutor();

    await expect(executor.prepare(`https://example.com/${String(detail)}.wasm`)).rejects.toMatchObject({
      name: 'UnzenNetworkError',
      message: `Failed to fetch MoonBit module: ${detail}`,
    });
    executor.dispose();
  });
});
