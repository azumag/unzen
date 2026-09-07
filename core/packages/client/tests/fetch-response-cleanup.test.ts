import { afterEach, describe, expect, it, vi } from 'vitest';
import { UnzenCancelledError, UnzenNetworkError } from '@unzen/shared';
import { CodeFetcher } from '../src/code-fetcher';
import { ManifestFetcher } from '../src/manifest-fetcher';
import { FallbackHandler } from '../src/fallback-handler';

const ENDPOINT = 'https://example.test/unzen';
const ENTRY = {
  runtime: 'quickjs' as const,
  hash: `sha256:${'a'.repeat(64)}`,
  version: 1,
  codeUrl: `${ENDPOINT}/code/test`,
};

afterEach(() => vi.unstubAllGlobals());

describe('rejected fetch response cleanup', () => {
  it.each(['code', 'manifest'] as const)('cancels a rejected %s response without waiting for cleanup', async (kind) => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const body = new ReadableStream<Uint8Array>({ cancel });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 503 })));
    const request = kind === 'code'
      ? new CodeFetcher(ENDPOINT).fetch(ENTRY)
      : new ManifestFetcher(ENDPOINT).fetch();
    await expect(request).rejects.toThrow(UnzenNetworkError);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  });

  it('releases a fallback response delivered after caller cancellation', async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    vi.stubGlobal('fetch', vi.fn(async () => {
      controller.abort();
      return new Response(body);
    }));
    await expect(new FallbackHandler(ENDPOINT).execute('test', [], controller.signal))
      .rejects.toThrow(UnzenCancelledError);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  });
});
