import { describe, expect, it } from 'vitest';
import { MoonBitSandboxExecutor } from '../src/moonbit-sandbox';

function revokedObjectProxy(): object {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy;
}

describe('MoonBit import-container trust boundary', () => {
  it('fails closed on a revoked top-level imports proxy', () => {
    expect(() => new MoonBitSandboxExecutor({
      imports: revokedObjectProxy() as WebAssembly.Imports,
    })).toThrow('MoonBit imports must be an object');
  });

  it('fails closed on a revoked nested import-module proxy', () => {
    expect(() => new MoonBitSandboxExecutor({
      imports: {
        env: revokedObjectProxy() as WebAssembly.ModuleImports,
      },
    })).toThrow('MoonBit import module "env" must be an object');
  });

  it('keeps enumeration failures inside the stable read diagnostic', () => {
    const hostile = {
      toString() {
        throw new Error('must not stringify caller failure');
      },
      [Symbol.toPrimitive]() {
        throw new Error('must not coerce caller failure');
      },
    };
    const imports = new Proxy({}, {
      ownKeys() {
        throw hostile;
      },
    });

    expect(() => new MoonBitSandboxExecutor({ imports }))
      .toThrow('MoonBit imports could not be read');
  });

  it('keeps property-read failures inside the stable read diagnostic', () => {
    const moduleImports = new Proxy({ value: 1 }, {
      get() {
        throw new Error('caller getter failure');
      },
    });

    expect(() => new MoonBitSandboxExecutor({
      imports: { env: moduleImports as WebAssembly.ModuleImports },
    })).toThrow('MoonBit imports could not be read');
  });

  it('continues to reject ordinary arrays as import containers', () => {
    expect(() => new MoonBitSandboxExecutor({ imports: [] as never }))
      .toThrow('MoonBit imports must be an object');
    expect(() => new MoonBitSandboxExecutor({
      imports: { env: [] as never },
    })).toThrow('MoonBit import module "env" must be an object');
  });

  it('preserves caller precedence and per-module merge semantics', () => {
    const printChar = () => {};
    const callerOnly = () => 7;
    const executor = new MoonBitSandboxExecutor({
      imports: {
        spectest: {
          print_char: printChar,
          caller_only: callerOnly,
        },
      },
    });

    const imports = (executor as unknown as { imports: WebAssembly.Imports }).imports;
    expect(Object.getPrototypeOf(imports)).toBeNull();
    expect(Object.getPrototypeOf(imports.spectest)).toBeNull();
    expect(imports.spectest.print_char).toBe(printChar);
    expect(imports.spectest.caller_only).toBe(callerOnly);

    executor.dispose();
  });
});
