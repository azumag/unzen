import { afterEach, describe, expect, it, vi } from 'vitest';
import { UnzenNetworkError } from '@unzen/shared';
import { MoonBitWorkerSandboxExecutor } from '../src/moonbit-worker-sandbox';

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

function workerLike(postMessage: (...args: unknown[]) => void = () => {}) {
  return {
    onmessage: null,
    onerror: null,
    postMessage,
    terminate: vi.fn(),
  } as unknown as Worker;
}

function createExecutor(createWorker: () => Worker) {
  return new MoonBitWorkerSandboxExecutor({
    workerUrl: '/moonbit-worker.js',
    createWorker,
  });
}

describe('MoonBitWorkerSandboxExecutor hostile rejection boundary', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('fails closed when module fetch rejects with a revoked Proxy', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(revokedErrorProxy()) as unknown as typeof fetch;
    const executor = createExecutor(() => workerLike());

    await expect(executor.prepare('https://example.com/revoked.wasm')).rejects.toMatchObject({
      name: 'UnzenNetworkError',
      message: 'Failed to fetch MoonBit module: Unknown error',
    });
    await expect(executor.prepare('https://example.com/revoked.wasm')).rejects.toBeInstanceOf(
      UnzenNetworkError,
    );
    executor.dispose();
  });

  it('does not coerce hostile fetch rejection values', async () => {
    const hostile = hostileObject();
    globalThis.fetch = vi.fn().mockRejectedValue(hostile.value) as unknown as typeof fetch;
    const executor = createExecutor(() => workerLike());

    await expect(executor.prepare('https://example.com/hostile.wasm')).rejects.toMatchObject({
      name: 'UnzenNetworkError',
      message: 'Failed to fetch MoonBit module: Unknown error',
    });
    expect(hostile.toPrimitive).not.toHaveBeenCalled();
    expect(hostile.valueOf).not.toHaveBeenCalled();
    expect(hostile.toString).not.toHaveBeenCalled();
    executor.dispose();
  });

  it('fails closed when Worker creation throws a revoked Proxy', async () => {
    const revoked = revokedErrorProxy();
    const executor = createExecutor(() => {
      throw revoked;
    });

    await expect(executor.execute(new ArrayBuffer(0), [])).rejects.toMatchObject({
      name: 'UnzenRuntimeError',
      message: 'Failed to create Worker: Unknown error',
    });
    executor.dispose();
  });

  it('does not coerce a hostile init postMessage failure', async () => {
    const hostile = hostileObject();
    const executor = createExecutor(() => workerLike(() => {
      throw hostile.value;
    }));

    await expect(executor.execute(new ArrayBuffer(0), [])).rejects.toMatchObject({
      name: 'UnzenRuntimeError',
      message: 'Failed to send init message: Unknown error',
    });
    expect(hostile.toPrimitive).not.toHaveBeenCalled();
    expect(hostile.valueOf).not.toHaveBeenCalled();
    expect(hostile.toString).not.toHaveBeenCalled();
    executor.dispose();
  });

  it('normalizes a live signal-state failure while racing prepare', async () => {
    let abortedReads = 0;
    const signal = {
      get aborted() {
        abortedReads++;
        if (abortedReads >= 2) throw new Error('hostile live signal state');
        return false;
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as AbortSignal;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      body: null,
      arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(0)),
    }) as unknown as typeof fetch;
    const executor = createExecutor(() => workerLike());

    await expect(executor.prepare('https://example.com/signal.wasm', signal)).rejects.toMatchObject({
      name: 'UnzenRuntimeError',
      message: 'signal state could not be read',
    });
    executor.dispose();
  });

  it('settles queued signal-state failures as an Error', async () => {
    const executor = createExecutor(() => workerLike());
    const first = executor.execute(new ArrayBuffer(0), []).catch(() => undefined);

    let abortedReads = 0;
    const signal = {
      get aborted() {
        abortedReads++;
        if (abortedReads >= 2) throw new Error('hostile queued signal state');
        return false;
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as AbortSignal;

    await expect(executor.execute(new ArrayBuffer(0), [], { signal })).rejects.toMatchObject({
      name: 'UnzenRuntimeError',
      message: 'MoonBit execution signal state could not be read',
    });

    executor.dispose();
    await first;
  });
});
