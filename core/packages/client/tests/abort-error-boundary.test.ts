import { describe, expect, it } from 'vitest';
import { isAbortError } from '../src/abort';

function revokedObjectProxy(): object {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy;
}

describe('abort-error classification trust boundary', () => {
  it('recognizes ordinary AbortError-shaped objects', () => {
    expect(isAbortError({ name: 'AbortError' })).toBe(true);
    expect(isAbortError({ name: 'TypeError' })).toBe(false);
  });

  it('rejects primitives without coercion', () => {
    expect(isAbortError(undefined)).toBe(false);
    expect(isAbortError(null)).toBe(false);
    expect(isAbortError('AbortError')).toBe(false);
    expect(isAbortError(1)).toBe(false);
  });

  it('fails closed on a revoked proxy', () => {
    expect(() => isAbortError(revokedObjectProxy())).not.toThrow();
    expect(isAbortError(revokedObjectProxy())).toBe(false);
  });

  it('fails closed on a throwing name getter without coercing the thrown value', () => {
    let coercions = 0;
    const hostile = {
      toString() {
        coercions += 1;
        throw new Error('must not stringify caller failure');
      },
      [Symbol.toPrimitive]() {
        coercions += 1;
        throw new Error('must not coerce caller failure');
      },
    };
    let reads = 0;
    const error = Object.defineProperty({}, 'name', {
      enumerable: true,
      get() {
        reads += 1;
        throw hostile;
      },
    });

    expect(isAbortError(error)).toBe(false);
    expect(reads).toBe(1);
    expect(coercions).toBe(0);
  });

  it('reads a successful name accessor once', () => {
    let reads = 0;
    const error = Object.defineProperty({}, 'name', {
      enumerable: true,
      get() {
        reads += 1;
        return 'AbortError';
      },
    });

    expect(isAbortError(error)).toBe(true);
    expect(reads).toBe(1);
  });
});
