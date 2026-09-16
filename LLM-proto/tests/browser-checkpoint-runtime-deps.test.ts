import { describe, expect, it, vi } from 'vitest';
import { waitForCheckpointBounded } from '../browser-harness/webgpu-2b-split/execution-lifecycle.js';

function okResponse(value: unknown = {}) {
  return {
    status: 200,
    ok: true,
    json: async () => value,
  };
}

function missingResponse() {
  return {
    status: 404,
    ok: false,
    json: async () => ({}),
  };
}

describe('browser checkpoint wait runtime dependency preflight', () => {
  it('rejects a malformed fetch dependency before clock, sleep, or poll work', async () => {
    const now = vi.fn(() => 1_000);
    const sleep = vi.fn(async () => {});

    await expect(waitForCheckpointBounded({
      timeoutMs: 1_000,
      pollIntervalMs: 100,
      now,
      sleep,
      fetchCheckpoint: null as unknown as () => Promise<ReturnType<typeof okResponse>>,
    })).rejects.toThrow('checkpoint fetch must be a function');

    expect(now).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('rejects a malformed sleep dependency before clock or checkpoint fetch', async () => {
    const now = vi.fn(() => 1_000);
    const fetchCheckpoint = vi.fn(async () => okResponse());

    await expect(waitForCheckpointBounded({
      timeoutMs: 1_000,
      pollIntervalMs: 100,
      now,
      fetchCheckpoint,
      sleep: 'sleep' as unknown as (ms: number, signal?: AbortSignal) => Promise<void>,
    })).rejects.toThrow('checkpoint sleep must be a function');

    expect(now).not.toHaveBeenCalled();
    expect(fetchCheckpoint).not.toHaveBeenCalled();
  });

  it('rejects an initially aborted signal before the first clock sample or fetch', async () => {
    const controller = new AbortController();
    controller.abort();
    const now = vi.fn(() => 1_000);
    const fetchCheckpoint = vi.fn(async () => okResponse());
    const sleep = vi.fn(async () => {});

    await expect(waitForCheckpointBounded({
      timeoutMs: 1_000,
      pollIntervalMs: 100,
      signal: controller.signal,
      now,
      fetchCheckpoint,
      sleep,
    })).rejects.toMatchObject({ name: 'AbortError' });

    expect(now).not.toHaveBeenCalled();
    expect(fetchCheckpoint).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('rejects an unreadable signal before the first clock sample or fetch', async () => {
    const signal = {
      get aborted() {
        throw new Error('signal exploded');
      },
    } as unknown as AbortSignal;
    const now = vi.fn(() => 1_000);
    const fetchCheckpoint = vi.fn(async () => okResponse());
    const sleep = vi.fn(async () => {});

    await expect(waitForCheckpointBounded({
      timeoutMs: 1_000,
      pollIntervalMs: 100,
      signal,
      now,
      fetchCheckpoint,
      sleep,
    })).rejects.toThrow('AbortSignal state could not be read');

    expect(now).not.toHaveBeenCalled();
    expect(fetchCheckpoint).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('rejects a regressing clock before extending the first residual wait', async () => {
    const now = vi.fn()
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(999);
    const fetchCheckpoint = vi.fn(async () => missingResponse());
    const sleep = vi.fn(async () => {});

    await expect(waitForCheckpointBounded({
      timeoutMs: 1_000,
      pollIntervalMs: 100,
      now,
      fetchCheckpoint,
      sleep,
    })).rejects.toThrow('checkpoint clock must be monotonic non-decreasing');

    expect(now).toHaveBeenCalledTimes(2);
    expect(fetchCheckpoint).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('rejects a clock regression after sleep before another checkpoint fetch', async () => {
    const now = vi.fn()
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_050)
      .mockReturnValueOnce(1_049);
    const fetchCheckpoint = vi.fn(async () => missingResponse());
    const sleep = vi.fn(async () => {});

    await expect(waitForCheckpointBounded({
      timeoutMs: 1_000,
      pollIntervalMs: 100,
      now,
      fetchCheckpoint,
      sleep,
    })).rejects.toThrow('checkpoint clock must be monotonic non-decreasing');

    expect(now).toHaveBeenCalledTimes(3);
    expect(fetchCheckpoint).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(100, undefined);
  });

  it('preserves the valid immediate checkpoint path', async () => {
    const checkpoint = { checkpointId: 'cp-preflight' };
    const now = vi.fn(() => 1_000);
    const fetchCheckpoint = vi.fn(async () => okResponse(checkpoint));
    const sleep = vi.fn(async () => {});

    await expect(waitForCheckpointBounded({
      timeoutMs: 1_000,
      pollIntervalMs: 100,
      now,
      fetchCheckpoint,
      sleep,
    })).resolves.toEqual(checkpoint);

    expect(now).toHaveBeenCalledTimes(1);
    expect(fetchCheckpoint).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
