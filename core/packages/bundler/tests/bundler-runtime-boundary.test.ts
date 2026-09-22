import { describe, expect, it } from 'vitest';
import {
  bundle,
  normalizeMaxBundleSize,
  snapshotAllowedModules,
} from '../src/bundler';

function createHostileValue(calls: string[]): object {
  return {
    [Symbol.toPrimitive]() {
      calls.push('Symbol.toPrimitive');
      throw new Error('must not coerce');
    },
    valueOf() {
      calls.push('valueOf');
      throw new Error('must not coerce');
    },
    toString() {
      calls.push('toString');
      throw new Error('must not coerce');
    },
  };
}

describe('bundler runtime ownership boundary', () => {
  it('rejects a revoked top-level option container with the stable diagnostic', async () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();

    await expect(bundle(proxy as never))
      .rejects.toThrow('Bundle options must be an object');
  });

  it('rejects a revoked allowedModules container with the stable read diagnostic', async () => {
    const { proxy, revoke } = Proxy.revocable<string[]>([], {});
    revoke();

    await expect(bundle({
      code: 'export function run() { return 1; }',
      allowedModules: proxy,
    })).rejects.toThrow('allowedModules could not be read');
  });

  it('does not coerce an invalid object maxBundleSize while building its diagnostic', () => {
    const calls: string[] = [];
    const value = createHostileValue(calls);

    expect(() => normalizeMaxBundleSize(value))
      .toThrow(/Invalid maxBundleSize \[object\]/);
    expect(calls).toEqual([]);
  });

  it('does not coerce an invalid function maxBundleSize while building its diagnostic', () => {
    const calls: string[] = [];
    const value = Object.assign(function hostile() {}, createHostileValue(calls));

    expect(() => normalizeMaxBundleSize(value))
      .toThrow(/Invalid maxBundleSize \[function\]/);
    expect(calls).toEqual([]);
  });

  it('preserves useful primitive maxBundleSize diagnostics', () => {
    expect(() => normalizeMaxBundleSize('32'))
      .toThrow(/Invalid maxBundleSize 32:/);
    expect(() => normalizeMaxBundleSize(null))
      .toThrow(/Invalid maxBundleSize null:/);
  });

  it('normalizes hostile numeric-index getter failures without inspecting the thrown value', () => {
    const calls: string[] = [];
    const hostile = createHostileValue(calls);
    const allowedModules = new Proxy(['safe'], {
      get(target, property, receiver) {
        if (property === '0') throw hostile;
        return Reflect.get(target, property, receiver);
      },
    });

    expect(() => snapshotAllowedModules(allowedModules))
      .toThrow('allowedModules could not be read');
    expect(calls).toEqual([]);
  });

  it('normalizes a revoked value thrown by a numeric-index getter', () => {
    const { proxy: thrownValue, revoke } = Proxy.revocable({}, {});
    revoke();
    const allowedModules = new Proxy(['safe'], {
      get(target, property, receiver) {
        if (property === '0') throw thrownValue;
        return Reflect.get(target, property, receiver);
      },
    });

    expect(() => snapshotAllowedModules(allowedModules))
      .toThrow('allowedModules could not be read');
  });
});
