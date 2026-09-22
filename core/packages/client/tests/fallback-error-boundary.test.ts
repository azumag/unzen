import { afterEach, describe, expect, it, vi } from 'vitest';
import { UnzenNetworkError } from '@unzen/shared';
import { FallbackHandler } from '../src/fallback-handler';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('FallbackHandler rejection-value boundary', () => {
  it('normalizes a revoked Proxy fetch rejection', async () => {
    const pair = Proxy.revocable({}, {});
    pair.revoke();
    globalThis.fetch = vi.fn().mockRejectedValue(pair.proxy) as unknown as typeof fetch;
    const handler = new FallbackHandler('https://example.com');

    await expect(handler.execute('test', [])).rejects.toBeInstanceOf(UnzenNetworkError);
    await expect(handler.execute('test', [])).rejects.toThrow(
      'Failed to execute fallback: Unknown error',
    );
  });

  it('does not invoke coercion hooks on object fetch rejections', async () => {
    let coercions = 0;
    const failure = {
      [Symbol.toPrimitive]() {
        coercions += 1;
        throw new Error('coercion hook must not run');
      },
      valueOf() {
        coercions += 1;
        throw new Error('valueOf must not run');
      },
      toString() {
        coercions += 1;
        throw new Error('toString must not run');
      },
    };
    globalThis.fetch = vi.fn().mockRejectedValue(failure) as unknown as typeof fetch;
    const handler = new FallbackHandler('https://example.com');

    await expect(handler.execute('test', [])).rejects.toThrow(
      'Failed to execute fallback: Unknown error',
    );
    expect(coercions).toBe(0);
  });

  it('preserves ordinary Error and primitive rejection messages', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('ordinary failure'))
      .mockRejectedValueOnce('primitive failure');
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const handler = new FallbackHandler('https://example.com');

    await expect(handler.execute('test', [])).rejects.toThrow(
      'Failed to execute fallback: ordinary failure',
    );
    await expect(handler.execute('test', [])).rejects.toThrow(
      'Failed to execute fallback: primitive failure',
    );
  });

  it('preserves existing UnzenNetworkError identity', async () => {
    const failure = new UnzenNetworkError('known network failure');
    globalThis.fetch = vi.fn().mockRejectedValue(failure) as unknown as typeof fetch;
    const handler = new FallbackHandler('https://example.com');

    try {
      await handler.execute('test', []);
      throw new Error('expected fallback execution to reject');
    } catch (error) {
      expect(error).toBe(failure);
    }
  });
});
