import { describe, expect, it, vi } from 'vitest';
import { UnzenServer } from '../src/unzen-server';

function revokedObjectProxy(): object {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy;
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
});
