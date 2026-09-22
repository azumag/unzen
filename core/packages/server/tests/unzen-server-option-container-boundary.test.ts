import { describe, expect, it, vi } from 'vitest';
import { UnzenServer } from '../src/unzen-server';

function revokedObjectProxy(): object {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy;
}

function hostileObjectTimeout() {
  const coerce = vi.fn(() => {
    throw new Error('timeout coercion must not run');
  });
  return {
    value: {
      [Symbol.toPrimitive]: coerce,
      toString: coerce,
    },
    coerce,
  };
}

function hostileFunctionTimeout() {
  const coerce = vi.fn(() => {
    throw new Error('timeout coercion must not run');
  });
  const value = Object.assign(
    () => undefined,
    {
      [Symbol.toPrimitive]: coerce,
      toString: coerce,
    },
  );
  return { value, coerce };
}

describe('UnzenServer option container trust boundary', () => {
  it('normalizes a revoked constructor configuration proxy', () => {
    expect(() => new UnzenServer(revokedObjectProxy() as never))
      .toThrow('UnzenServer baseUrl configuration must be an object');
  });

  it('rejects revoked define options before inspecting the function or consuming a version', () => {
    const server = new UnzenServer();
    const inspect = vi.fn();
    const fn = new Proxy(() => 1, {
      getPrototypeOf() {
        inspect();
        throw new Error('function inspection must not run');
      },
    });

    expect(() => server.define('revokedDefineOptions', fn, revokedObjectProxy() as never))
      .toThrow('Unzen function options must be an object');
    expect(inspect).not.toHaveBeenCalled();
    expect(server.getFunction('revokedDefineOptions')).toBeUndefined();

    server.defineRaw('afterRevokedDefineOptions', '() => 1');
    expect(server.getFunction('afterRevokedDefineOptions')?.version).toBe(1);
  });

  it('rejects revoked defineRaw options before registration or version consumption', () => {
    const server = new UnzenServer();

    expect(() => server.defineRaw(
      'revokedRawOptions',
      '() => 1',
      revokedObjectProxy() as never,
    )).toThrow('Unzen function options must be an object');
    expect(server.getFunction('revokedRawOptions')).toBeUndefined();

    server.defineRaw('afterRevokedRawOptions', '() => 2');
    expect(server.getFunction('afterRevokedRawOptions')?.version).toBe(1);
  });

  it('rejects revoked MoonBit options before module file I/O or version consumption', () => {
    const server = new UnzenServer();
    const definitelyMissingPath = '/unzen-test/this-file-must-not-be-read.wasm';

    expect(() => server.defineMoonbit(
      'revokedMoonBitOptions',
      definitelyMissingPath,
      revokedObjectProxy() as never,
    )).toThrow('MoonBit definition options must be an object');
    expect(server.getFunction('revokedMoonBitOptions')).toBeUndefined();

    server.defineRaw('afterRevokedMoonBitOptions', '() => 3');
    expect(server.getFunction('afterRevokedMoonBitOptions')?.version).toBe(1);
  });

  it('does not coerce an object timeout before rejecting define options', () => {
    const server = new UnzenServer();
    const { value: timeout, coerce } = hostileObjectTimeout();
    const inspect = vi.fn();
    const fn = new Proxy(() => 1, {
      getPrototypeOf() {
        inspect();
        throw new Error('function inspection must not run');
      },
    });

    expect(() => server.define(
      'hostileObjectTimeout',
      fn,
      { timeout } as never,
    )).toThrow('Invalid timeout <object>: must be an integer between 1 and 2000ms');
    expect(coerce).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
    expect(server.getFunction('hostileObjectTimeout')).toBeUndefined();

    server.defineRaw('afterHostileObjectTimeout', '() => 1');
    expect(server.getFunction('afterHostileObjectTimeout')?.version).toBe(1);
  });

  it('does not coerce a function timeout before rejecting defineRaw options', () => {
    const server = new UnzenServer();
    const { value: timeout, coerce } = hostileFunctionTimeout();

    expect(() => server.defineRaw(
      'hostileFunctionTimeout',
      '() => 1',
      { timeout } as never,
    )).toThrow('Invalid timeout <function>: must be an integer between 1 and 2000ms');
    expect(coerce).not.toHaveBeenCalled();
    expect(server.getFunction('hostileFunctionTimeout')).toBeUndefined();

    server.defineRaw('afterHostileFunctionTimeout', '() => 2');
    expect(server.getFunction('afterHostileFunctionTimeout')?.version).toBe(1);
  });

  it('does not coerce an object timeout or read a MoonBit module before rejecting options', () => {
    const server = new UnzenServer();
    const { value: timeout, coerce } = hostileObjectTimeout();
    const definitelyMissingPath = '/unzen-test/hostile-timeout-must-fail-before-file-io.wasm';

    expect(() => server.defineMoonbit(
      'hostileMoonBitTimeout',
      definitelyMissingPath,
      { timeout } as never,
    )).toThrow('Invalid timeout <object>: must be an integer between 1 and 2000ms');
    expect(coerce).not.toHaveBeenCalled();
    expect(server.getFunction('hostileMoonBitTimeout')).toBeUndefined();

    server.defineRaw('afterHostileMoonBitTimeout', '() => 3');
    expect(server.getFunction('afterHostileMoonBitTimeout')?.version).toBe(1);
  });

  it('preserves primitive invalid-timeout diagnostics', () => {
    const server = new UnzenServer();

    expect(() => server.defineRaw('zeroTimeout', '() => 1', { timeout: 0 }))
      .toThrow('Invalid timeout 0: must be an integer between 1 and 2000ms');
    expect(() => server.defineRaw(
      'stringTimeout',
      '() => 1',
      { timeout: 'slow' } as never,
    )).toThrow('Invalid timeout slow: must be an integer between 1 and 2000ms');
  });
});
