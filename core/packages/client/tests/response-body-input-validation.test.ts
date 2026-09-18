import { describe, expect, it, vi } from 'vitest';
import {
  readBoundedJsonResponse,
  readBoundedResponseBytes,
} from '../src/response-body';

describe('bounded response input validation', () => {
  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5])(
    'rejects invalid byte ceiling %s before acquiring a reader',
    async (maximumBytes) => {
      const getReader = vi.fn();
      const cancel = vi.fn().mockResolvedValue(undefined);
      const response = {
        headers: new Headers(),
        body: { getReader, cancel },
      } as unknown as Response;

      await expect(readBoundedResponseBytes(response, maximumBytes, 'Byte response'))
        .rejects.toThrow('maximumBytes must be a non-negative safe integer');
      expect(getReader).not.toHaveBeenCalled();
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it('rejects an invalid byte ceiling before invoking arrayBuffer()', async () => {
    const arrayBuffer = vi.fn().mockResolvedValue(new ArrayBuffer(0));
    const response = {
      headers: new Headers(),
      body: null,
      arrayBuffer,
    } as unknown as Response;

    await expect(readBoundedResponseBytes(response, Number.POSITIVE_INFINITY, 'Byte response'))
      .rejects.toThrow('maximumBytes must be a non-negative safe integer');
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('rejects an invalid byte ceiling before invoking json()', async () => {
    const json = vi.fn().mockResolvedValue({ ok: true });
    const response = {
      headers: new Headers(),
      json,
    } as unknown as Response;

    await expect(readBoundedJsonResponse(response, Number.NaN, 'JSON response'))
      .rejects.toThrow('maximumBytes must be a non-negative safe integer');
    expect(json).not.toHaveBeenCalled();
  });

  it('accepts a zero-byte ceiling for an empty response', async () => {
    const response = new Response(new Uint8Array(0));

    await expect(readBoundedResponseBytes(response, 0, 'Empty response'))
      .resolves.toEqual(new ArrayBuffer(0));
  });

  it('does not coerce non-string Content-Length values from structural adapters', async () => {
    const trim = vi.fn(() => '1000');
    const toString = vi.fn(() => '1000');
    const toPrimitive = vi.fn(() => '1000');
    const headerValue = {
      trim,
      toString,
      [Symbol.toPrimitive]: toPrimitive,
    };
    const reader = {
      read: vi.fn()
        .mockResolvedValueOnce({ done: false, value: new Uint8Array([1, 2]) })
        .mockResolvedValueOnce({ done: true, value: undefined }),
      cancel: vi.fn(),
      releaseLock: vi.fn(),
    };
    const response = {
      headers: { get: vi.fn(() => headerValue) },
      body: { getReader: vi.fn(() => reader) },
    } as unknown as Response;

    const bytes = await readBoundedResponseBytes(response, 2, 'Byte response');

    expect([...new Uint8Array(bytes)]).toEqual([1, 2]);
    expect(trim).not.toHaveBeenCalled();
    expect(toString).not.toHaveBeenCalled();
    expect(toPrimitive).not.toHaveBeenCalled();
    expect(reader.cancel).not.toHaveBeenCalled();
    expect(reader.releaseLock).toHaveBeenCalledOnce();
  });
});
