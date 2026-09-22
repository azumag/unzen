import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { UnzenNetworkError, type FunctionManifestEntry } from '@unzen/shared';
import { CodeFetcher } from '../src/code-fetcher';

const originalFetch = globalThis.fetch;
const hash = `sha256:${createHash('sha256').update('code', 'utf8').digest('hex')}`;
const entry: FunctionManifestEntry = {
  version: 1,
  runtime: 'quickjs',
  codeUrl: 'https://example.com/code.js',
  hash,
};

function revokedObjectProxy(): object {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy;
}

describe('CodeFetcher rejection-value trust boundary', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('maps a revoked rejection proxy to a stable network error', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(revokedObjectProxy());
    const fetcher = new CodeFetcher('https://example.com');

    await expect(fetcher.fetch(entry)).rejects.toMatchObject({
      name: 'UnzenNetworkError',
      message: 'Failed to fetch code: Unknown error',
    });
  });

  it('does not coerce hostile object rejection values', async () => {
    let coercions = 0;
    const hostile = {
      toString() {
        coercions += 1;
        throw new Error('must not stringify rejection');
      },
      valueOf() {
        coercions += 1;
        throw new Error('must not valueOf rejection');
      },
      [Symbol.toPrimitive]() {
        coercions += 1;
        throw new Error('must not coerce rejection');
      },
    };
    globalThis.fetch = vi.fn().mockRejectedValue(hostile);
    const fetcher = new CodeFetcher('https://example.com');

    await expect(fetcher.fetch(entry)).rejects.toThrow(
      'Failed to fetch code: Unknown error',
    );
    expect(coercions).toBe(0);
  });

  it('preserves ordinary Error messages', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network exploded'));
    const fetcher = new CodeFetcher('https://example.com');

    await expect(fetcher.fetch(entry)).rejects.toThrow(
      'Failed to fetch code: network exploded',
    );
  });

  it('rethrows an existing UnzenNetworkError unchanged', async () => {
    const original = new UnzenNetworkError('already normalized');
    globalThis.fetch = vi.fn().mockRejectedValue(original);
    const fetcher = new CodeFetcher('https://example.com');

    try {
      await fetcher.fetch(entry);
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBe(original);
    }
  });

  it('preserves primitive rejection text without object coercion', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue('offline');
    const fetcher = new CodeFetcher('https://example.com');

    await expect(fetcher.fetch(entry)).rejects.toThrow(
      'Failed to fetch code: offline',
    );
  });
});
