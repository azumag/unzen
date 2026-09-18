import { describe, expect, it, vi } from 'vitest';
import { readBoundedJsonRequest } from '../src/request-body';

function requestWithReader(
  reader: unknown,
  headers: unknown = new Headers(),
): Request {
  return {
    headers,
    body: {
      getReader: () => reader,
      cancel: vi.fn().mockResolvedValue(undefined),
    },
  } as unknown as Request;
}

describe('bounded request input validation', () => {
  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5])(
    'rejects invalid byte ceiling %s before acquiring a reader',
    async (maximumBytes) => {
      const getReader = vi.fn();
      const cancel = vi.fn().mockResolvedValue(undefined);
      const request = {
        headers: new Headers(),
        body: { getReader, cancel },
      } as unknown as Request;

      await expect(readBoundedJsonRequest(request, maximumBytes, 'JSON request'))
        .rejects.toThrow('maximumBytes must be a non-negative safe integer');
      expect(getReader).not.toHaveBeenCalled();
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

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
        .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode('{}') })
        .mockResolvedValueOnce({ done: true, value: undefined }),
      cancel: vi.fn(),
      releaseLock: vi.fn(),
    };
    const request = requestWithReader(
      reader,
      { get: vi.fn(() => headerValue) },
    );

    await expect(readBoundedJsonRequest(request, 2, 'JSON request'))
      .resolves.toEqual({});
    expect(trim).not.toHaveBeenCalled();
    expect(toString).not.toHaveBeenCalled();
    expect(toPrimitive).not.toHaveBeenCalled();
    expect(reader.cancel).not.toHaveBeenCalled();
    expect(reader.releaseLock).toHaveBeenCalledOnce();
  });

  it('rejects a non-object reader result and cleans up the reader', async () => {
    const reader = {
      read: vi.fn().mockResolvedValue(null),
      cancel: vi.fn(),
      releaseLock: vi.fn(),
    };
    const request = requestWithReader(reader);

    await expect(readBoundedJsonRequest(request, 100, 'JSON request'))
      .rejects.toThrow('body returned an invalid reader result');
    expect(reader.cancel).toHaveBeenCalledOnce();
    expect(reader.releaseLock).toHaveBeenCalledOnce();
  });

  it('rejects a non-boolean done flag instead of accepting truthy EOF', async () => {
    const reader = {
      read: vi.fn().mockResolvedValue({ done: 1, value: new TextEncoder().encode('{}') }),
      cancel: vi.fn(),
      releaseLock: vi.fn(),
    };
    const request = requestWithReader(reader);

    await expect(readBoundedJsonRequest(request, 100, 'JSON request'))
      .rejects.toThrow('body returned a non-boolean done flag');
    expect(reader.cancel).toHaveBeenCalledOnce();
    expect(reader.releaseLock).toHaveBeenCalledOnce();
  });

  it('does not inspect value on a terminal reader result', async () => {
    const valueGetter = vi.fn(() => {
      throw new Error('terminal value must not be read');
    });
    const terminal = { done: true } as { done: boolean; value?: unknown };
    Object.defineProperty(terminal, 'value', { get: valueGetter });
    const reader = {
      read: vi.fn()
        .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode('{}') })
        .mockResolvedValueOnce(terminal),
      cancel: vi.fn(),
      releaseLock: vi.fn(),
    };
    const request = requestWithReader(reader);

    await expect(readBoundedJsonRequest(request, 100, 'JSON request'))
      .resolves.toEqual({});
    expect(valueGetter).not.toHaveBeenCalled();
    expect(reader.cancel).not.toHaveBeenCalled();
    expect(reader.releaseLock).toHaveBeenCalledOnce();
  });

  it('rejects a non-terminal result without a byte value', async () => {
    const reader = {
      read: vi.fn().mockResolvedValue({ done: false }),
      cancel: vi.fn(),
      releaseLock: vi.fn(),
    };
    const request = requestWithReader(reader);

    await expect(readBoundedJsonRequest(request, 100, 'JSON request'))
      .rejects.toThrow('body returned a non-byte chunk');
    expect(reader.cancel).toHaveBeenCalledOnce();
    expect(reader.releaseLock).toHaveBeenCalledOnce();
  });
});
