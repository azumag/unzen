import { describe, expect, it, vi } from 'vitest';
import { readBoundedResponseBytes } from '../src/response-body';

function responseWithReader(reader: unknown): Response {
  return {
    headers: new Headers(),
    body: {
      getReader: () => reader,
    },
  } as unknown as Response;
}

describe('bounded response reader result contract', () => {
  it.each([null, undefined, 0, 'done'])('rejects invalid reader result containers: %s', async (result) => {
    const reader = {
      read: vi.fn().mockResolvedValue(result),
      cancel: vi.fn(),
      releaseLock: vi.fn(),
    };

    await expect(readBoundedResponseBytes(responseWithReader(reader), 10, 'Byte response'))
      .rejects.toThrow('Byte response body returned an invalid reader result');
    expect(reader.cancel).toHaveBeenCalledOnce();
    expect(reader.releaseLock).toHaveBeenCalledOnce();
  });

  it.each([0, 1, null, undefined, 'false'])('rejects non-boolean done flags: %s', async (done) => {
    const reader = {
      read: vi.fn().mockResolvedValue({ done, value: new Uint8Array([1]) }),
      cancel: vi.fn(),
      releaseLock: vi.fn(),
    };

    await expect(readBoundedResponseBytes(responseWithReader(reader), 10, 'Byte response'))
      .rejects.toThrow('Byte response body returned a non-boolean done flag');
    expect(reader.cancel).toHaveBeenCalledOnce();
    expect(reader.releaseLock).toHaveBeenCalledOnce();
  });

  it('rejects a non-terminal result without byte data', async () => {
    const reader = {
      read: vi.fn().mockResolvedValue({ done: false }),
      cancel: vi.fn(),
      releaseLock: vi.fn(),
    };

    await expect(readBoundedResponseBytes(responseWithReader(reader), 10, 'Byte response'))
      .rejects.toThrow('Byte response body returned a non-byte chunk');
    expect(reader.cancel).toHaveBeenCalledOnce();
    expect(reader.releaseLock).toHaveBeenCalledOnce();
  });

  it('does not read terminal value and accepts a normal false-to-true sequence', async () => {
    let terminalValueReads = 0;
    const terminal = {
      done: true,
      get value() {
        terminalValueReads += 1;
        throw new Error('terminal value must not be read');
      },
    };
    const reader = {
      read: vi.fn()
        .mockResolvedValueOnce({ done: false, value: new Uint8Array([1, 2, 3]) })
        .mockResolvedValueOnce(terminal),
      cancel: vi.fn(),
      releaseLock: vi.fn(),
    };

    await expect(readBoundedResponseBytes(responseWithReader(reader), 10, 'Byte response'))
      .resolves.toEqual(new Uint8Array([1, 2, 3]).buffer);
    expect(terminalValueReads).toBe(0);
    expect(reader.cancel).not.toHaveBeenCalled();
    expect(reader.releaseLock).toHaveBeenCalledOnce();
  });
});
