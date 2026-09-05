import { describe, expect, it, vi } from 'vitest';
import {
  CheckpointWaitTimeoutError,
  ownSession,
  waitForCheckpointBounded,
} from '../browser-harness/webgpu-2b-split/execution-lifecycle.js';

function response(status: number, value: unknown = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => value,
  };
}

describe('browser execution lifecycle', () => {
  it('can stop a checkpoint wait and does not poll again', async () => {
    const controller = new AbortController();
    let fetches = 0;
    const waiting = waitForCheckpointBounded({
      signal: controller.signal,
      timeoutMs: 10_000,
      pollIntervalMs: 500,
      fetchCheckpoint: async () => {
        fetches += 1;
        return response(404);
      },
      sleep: async (_ms, signal) => {
        controller.abort();
        if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
      },
    });

    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetches).toBe(1);
  });

  it('stops at the configured checkpoint deadline', async () => {
    let now = 1_000;
    let fetches = 0;
    const waiting = waitForCheckpointBounded({
      timeoutMs: 1_000,
      pollIntervalMs: 400,
      now: () => now,
      fetchCheckpoint: async () => {
        fetches += 1;
        return response(404);
      },
      sleep: async (ms) => {
        now += ms;
      },
    });

    await expect(waiting).rejects.toBeInstanceOf(CheckpointWaitTimeoutError);
    expect(now).toBe(2_000);
    expect(fetches).toBe(3);
  });

  it('returns immediately once the checkpoint appears', async () => {
    let fetches = 0;
    const checkpoint = { checkpointId: 'cp-1' };
    const value = await waitForCheckpointBounded({
      timeoutMs: 1_000,
      pollIntervalMs: 1,
      fetchCheckpoint: async () => {
        fetches += 1;
        return fetches === 1 ? response(404) : response(200, checkpoint);
      },
      sleep: async () => {},
    });

    expect(value).toEqual(checkpoint);
    expect(fetches).toBe(2);
  });

  it('releases an ORT session exactly once after success', async () => {
    const release = vi.fn(async () => {});
    const owner = ownSession({ release });

    expect(await owner.release()).toBe(true);
    expect(await owner.release()).toBe(false);
    expect(owner.released).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('supports try/finally release when inference throws', async () => {
    const release = vi.fn(async () => {});
    const owner = ownSession({ release });

    await expect((async () => {
      try {
        throw new Error('fake ORT run failure');
      } finally {
        await owner.release();
      }
    })()).rejects.toThrow('fake ORT run failure');
    expect(release).toHaveBeenCalledTimes(1);
  });
});
