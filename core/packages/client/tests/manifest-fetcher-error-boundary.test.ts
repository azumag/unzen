import { afterEach, describe, expect, it, vi } from 'vitest';
import { UnzenCancelledError, UnzenNetworkError } from '@unzen/shared';
import { ManifestFetcher } from '../src/manifest-fetcher';

const originalFetch = globalThis.fetch;

function revokedObjectProxy(): object {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy;
}

describe('ManifestFetcher rejection-value trust boundary', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('maps a revoked rejection proxy to a stable network error', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(revokedObjectProxy());
    const fetcher = new ManifestFetcher('https://example.com');

    await expect(fetcher.fetch()).rejects.toMatchObject({
      name: 'UnzenNetworkError',
      message: 'Failed to fetch manifest: Unknown error',
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
    const fetcher = new ManifestFetcher('https://example.com');

    await expect(fetcher.fetch()).rejects.toThrow(
      'Failed to fetch manifest: Unknown error',
    );
    expect(coercions).toBe(0);
  });

  it('preserves ordinary Error messages', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network exploded'));
    const fetcher = new ManifestFetcher('https://example.com');

    await expect(fetcher.fetch()).rejects.toThrow(
      'Failed to fetch manifest: network exploded',
    );
  });

  it('rethrows existing client errors unchanged', async () => {
    for (const original of [
      new UnzenNetworkError('already network-normalized'),
      new UnzenCancelledError('already cancelled'),
    ]) {
      globalThis.fetch = vi.fn().mockRejectedValue(original);
      const fetcher = new ManifestFetcher('https://example.com');

      try {
        await fetcher.fetch();
        throw new Error('expected rejection');
      } catch (error) {
        expect(error).toBe(original);
      }
    }
  });

  it('keeps AbortError-shaped rejections on the cancellation path', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue({ name: 'AbortError' });
    const fetcher = new ManifestFetcher('https://example.com');

    await expect(fetcher.fetch()).rejects.toThrow(UnzenCancelledError);
  });

  it('preserves primitive rejection text', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue('offline');
    const fetcher = new ManifestFetcher('https://example.com');

    await expect(fetcher.fetch()).rejects.toThrow(
      'Failed to fetch manifest: offline',
    );
  });
});
