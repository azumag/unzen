import { describe, expect, it, vi } from 'vitest';
import { readResponseBytesBounded } from '../browser-harness/webgpu-2b-split/artifact-cache.js';

function responseFor(reader: unknown) {
  return {
    headers: { get: () => null },
    body: { getReader: () => reader },
  };
}

describe('artifact stream reader result contract', () => {
  it.each([null, undefined, 0, 'done', true])('rejects non-object reader result %s', async (result) => {
    const cancel = vi.fn();
    const releaseLock = vi.fn();
    const reader = {
      read: vi.fn(async () => result),
      cancel,
      releaseLock,
    };

    await expect(readResponseBytesBounded(responseFor(reader), { url: 'segment.onnx' }))
      .rejects.toThrow('artifact reader returned an invalid result for segment.onnx');
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });

  it.each([1, 0, 'true', '', null, undefined])('rejects non-boolean done flag %s', async (done) => {
    const cancel = vi.fn();
    const releaseLock = vi.fn();
    const reader = {
      read: vi.fn(async () => ({ done, value: new Uint8Array([1]) })),
      cancel,
      releaseLock,
    };

    await expect(readResponseBytesBounded(responseFor(reader), { url: 'segment.onnx' }))
      .rejects.toThrow('artifact reader returned a non-boolean done flag for segment.onnx');
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });

  it('does not read value after a terminal reader result', async () => {
    const cancel = vi.fn();
    const releaseLock = vi.fn();
    let valueReads = 0;
    const terminalResult = {
      done: true,
      get value() {
        valueReads += 1;
        throw new Error('terminal value getter must not run');
      },
    };
    const reader = {
      read: vi.fn(async () => terminalResult),
      cancel,
      releaseLock,
    };

    await expect(readResponseBytesBounded(responseFor(reader), { url: 'segment.onnx' }))
      .resolves.toEqual(new Uint8Array());
    expect(valueReads).toBe(0);
    expect(cancel).not.toHaveBeenCalled();
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });

  it('reads non-terminal value once and cleans up when its getter throws', async () => {
    const cancel = vi.fn();
    const releaseLock = vi.fn();
    let valueReads = 0;
    const nonTerminalResult = {
      done: false,
      get value() {
        valueReads += 1;
        throw new Error('chunk value exploded');
      },
    };
    const reader = {
      read: vi.fn(async () => nonTerminalResult),
      cancel,
      releaseLock,
    };

    await expect(readResponseBytesBounded(responseFor(reader), { url: 'segment.onnx' }))
      .rejects.toThrow('chunk value exploded');
    expect(valueReads).toBe(1);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });

  it('preserves the native false-to-true reader result sequence', async () => {
    const cancel = vi.fn();
    const releaseLock = vi.fn();
    let reads = 0;
    const reader = {
      read: vi.fn(async () => {
        reads += 1;
        return reads === 1
          ? { done: false, value: new Uint8Array([7, 8]) }
          : { done: true, value: undefined };
      }),
      cancel,
      releaseLock,
    };

    await expect(readResponseBytesBounded(responseFor(reader), {
      maxBytes: 2,
      expectedBytes: 2,
    })).resolves.toEqual(new Uint8Array([7, 8]));
    expect(reader.read).toHaveBeenCalledTimes(2);
    expect(cancel).not.toHaveBeenCalled();
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });
});
