import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadVerifiedArtifact } from '../browser-harness/webgpu-2b-split/artifact-cache.js';

const URL = 'https://artifacts.example.test/segment.onnx';
const PAYLOAD = new Uint8Array([1, 2, 3, 4]);
const DIGEST = createHash('sha256').update(PAYLOAD).digest('hex');
const KEY = `${URL}?__unzen_sha256=${DIGEST}`;

function setup(cached = false) {
  const entries = new Map<string, Response>();
  if (cached) entries.set(KEY, new Response(PAYLOAD));
  const store = async (key: string, response: Response) => { entries.set(key, response.clone()); };
  const cache = {
    match: vi.fn(async (key: string) => entries.get(key)?.clone()),
    put: vi.fn(store),
    delete: vi.fn(async (key: string) => entries.delete(key)),
  };
  const fetch = vi.fn(async () => new Response(PAYLOAD));
  vi.stubGlobal('caches', { open: vi.fn(async () => cache) });
  vi.stubGlobal('location', { href: URL });
  vi.stubGlobal('fetch', fetch);
  return { entries, cache, fetch, store };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('verified artifact cache failure isolation', () => {
  it('cancels an unsuccessful network response before abandoning its body', async () => {
    const { fetch } = setup();
    const cancel = vi.fn();
    fetch.mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { status: 503 }));
    await expect(loadVerifiedArtifact(URL, DIGEST)).rejects.toThrow(/artifact fetch failed 503/);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('releases a cache response returned after cancellation without evicting it', async () => {
    const { cache, entries } = setup(true);
    const controller = new AbortController();
    const cancel = vi.fn();
    cache.match.mockImplementationOnce(async () => {
      controller.abort();
      return new Response(new ReadableStream({ cancel }));
    });
    await expect(loadVerifiedArtifact(URL, DIGEST, { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(entries.has(KEY)).toBe(true);
  });

  it('verifies a network payload and reuses the verified cache entry', async () => {
    const { fetch } = setup();
    const first = await loadVerifiedArtifact(URL, DIGEST, { expectedBytes: 4 });
    const second = await loadVerifiedArtifact(URL, DIGEST, { expectedBytes: 4 });
    expect([...first.bytes]).toEqual([...PAYLOAD]);
    expect(first.report).toMatchObject({ cacheHit: false, digestVerified: true });
    expect(second.report).toMatchObject({ cacheHit: true, digestVerified: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not evict a verified cache hit when its reader is cancelled', async () => {
    const { cache, entries } = setup(true);
    const controller = new AbortController();
    cache.match.mockImplementationOnce(async () => new Response(new ReadableStream<Uint8Array>({
      pull(streamController) {
        streamController.enqueue(PAYLOAD);
        queueMicrotask(() => controller.abort());
      },
    }, { highWaterMark: 0 })));
    await expect(loadVerifiedArtifact(URL, DIGEST, { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(entries.has(KEY)).toBe(true);
    expect(cache.delete).not.toHaveBeenCalled();
    expect((await loadVerifiedArtifact(URL, DIGEST)).report.cacheHit).toBe(true);
  });

  it('keeps successfully verified bytes when cancellation arrives during cache.put', async () => {
    const { cache, store, entries } = setup();
    const controller = new AbortController();
    cache.put.mockImplementationOnce(async (key, response) => {
      await store(key, response);
      controller.abort();
    });
    await expect(loadVerifiedArtifact(URL, DIGEST, { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(entries.has(KEY)).toBe(true);
    expect(cache.delete).not.toHaveBeenCalled();
  });

  it('preserves the integrity error even when removing a corrupt cached entry fails', async () => {
    const { cache, entries } = setup(true);
    entries.set(KEY, new Response(new Uint8Array([9, 9, 9, 9])));
    cache.delete.mockRejectedValueOnce(new Error('cache delete unavailable'));
    await expect(loadVerifiedArtifact(URL, DIGEST)).rejects.toThrow(/SHA-256 mismatch/);
    expect(cache.delete).toHaveBeenCalledWith(KEY);
  });

  it('evicts a corrupt cached entry so the next attempt can fetch valid bytes', async () => {
    const { entries, fetch } = setup(true);
    entries.set(KEY, new Response(new Uint8Array([9, 9, 9, 9])));
    await expect(loadVerifiedArtifact(URL, DIGEST)).rejects.toThrow(/SHA-256 mismatch/);
    expect(entries.has(KEY)).toBe(false);
    expect((await loadVerifiedArtifact(URL, DIGEST)).report.cacheHit).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not let a failed cache miss delete a concurrent successful download', async () => {
    const { fetch, entries, cache } = setup();
    let finishBad!: (response: Response) => void;
    const badResponse = new Promise<Response>((resolve) => { finishBad = resolve; });
    fetch.mockImplementationOnce(() => badResponse);
    const bad = loadVerifiedArtifact(URL, DIGEST);
    const badRejected = expect(bad).rejects.toThrow(/SHA-256 mismatch/);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    try {
      await loadVerifiedArtifact(URL, DIGEST);
      expect(entries.has(KEY)).toBe(true);
    } finally {
      finishBad(new Response(new Uint8Array([9, 9, 9, 9])));
    }
    await badRejected;
    expect(entries.has(KEY)).toBe(true);
    expect(cache.delete).not.toHaveBeenCalled();
  });
});
