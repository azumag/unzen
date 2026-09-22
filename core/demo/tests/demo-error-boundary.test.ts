import { describe, expect, it, vi } from 'vitest';
import { formatDemoThrownValue } from '../public/demo-error-boundary.js';

describe('demo execution error boundary', () => {
  it('preserves ordinary Error messages', () => {
    expect(formatDemoThrownValue(new Error('boom'))).toBe('boom');
  });

  it('preserves useful primitive diagnostics', () => {
    expect(formatDemoThrownValue('boom')).toBe('boom');
    expect(formatDemoThrownValue(42)).toBe('42');
    expect(formatDemoThrownValue(false)).toBe('false');
    expect(formatDemoThrownValue(null)).toBe('null');
    expect(formatDemoThrownValue(undefined)).toBe('undefined');
  });

  it('does not invoke object coercion hooks', () => {
    const toPrimitive = vi.fn(() => {
      throw new Error('must not run');
    });
    const valueOf = vi.fn(() => {
      throw new Error('must not run');
    });
    const toString = vi.fn(() => {
      throw new Error('must not run');
    });
    const hostile = {
      [Symbol.toPrimitive]: toPrimitive,
      valueOf,
      toString,
    };

    expect(formatDemoThrownValue(hostile)).toBe('Unknown error');
    expect(toPrimitive).not.toHaveBeenCalled();
    expect(valueOf).not.toHaveBeenCalled();
    expect(toString).not.toHaveBeenCalled();
  });

  it('does not invoke function coercion hooks', () => {
    const toPrimitive = vi.fn(() => {
      throw new Error('must not run');
    });
    const hostile = function hostileFunction() {};
    Object.defineProperty(hostile, Symbol.toPrimitive, { value: toPrimitive });

    expect(formatDemoThrownValue(hostile)).toBe('Unknown error');
    expect(toPrimitive).not.toHaveBeenCalled();
  });

  it('fails closed when Error.message throws', () => {
    const error = new Error('hidden');
    Object.defineProperty(error, 'message', {
      get() {
        throw new Error('hostile message');
      },
    });

    expect(() => formatDemoThrownValue(error)).not.toThrow();
    expect(formatDemoThrownValue(error)).toBe('Unknown error');
  });

  it('does not coerce an object-valued Error.message', () => {
    const toPrimitive = vi.fn(() => {
      throw new Error('must not run');
    });
    const message = { [Symbol.toPrimitive]: toPrimitive };
    const error = new Error('placeholder');
    Object.defineProperty(error, 'message', { value: message });

    expect(formatDemoThrownValue(error)).toBe('Unknown error');
    expect(toPrimitive).not.toHaveBeenCalled();
  });

  it('fails closed on a revoked Proxy', () => {
    const { proxy, revoke } = Proxy.revocable(new Error('hidden'), {});
    revoke();

    expect(() => formatDemoThrownValue(proxy)).not.toThrow();
    expect(formatDemoThrownValue(proxy)).toBe('Unknown error');
  });

  it('fails closed when a Proxy-wrapped Error message read throws', () => {
    const error = new Proxy(new Error('hidden'), {
      get(target, property, receiver) {
        if (property === 'message') throw new Error('hostile message trap');
        return Reflect.get(target, property, receiver);
      },
    });

    expect(formatDemoThrownValue(error)).toBe('Unknown error');
  });
});
