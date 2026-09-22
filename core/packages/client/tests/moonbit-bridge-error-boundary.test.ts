import { describe, expect, it } from 'vitest';
import {
  marshalMoonBitArguments,
  unmarshalMoonBitResult,
} from '../src/moonbit-array-bridge';

function fakeInstance(exports: Record<string, unknown>): WebAssembly.Instance {
  return { exports } as unknown as WebAssembly.Instance;
}

describe('MoonBit array bridge error boundary', () => {
  it('normalizes a revoked Proxy thrown while copying an argument', () => {
    const pair = Proxy.revocable({}, {});
    pair.revoke();
    const instance = fakeInstance({
      unzen_array_i32_new: () => { throw pair.proxy; },
      unzen_array_i32_set: () => {},
    });

    expect(() => marshalMoonBitArguments(
      instance,
      [[1]],
      { params: ['i32[]'] },
    )).toThrow('MoonBit i32[] bridge failed while copying argument 0: Unknown error');
  });

  it('does not invoke coercion hooks on thrown bridge values', () => {
    let coercions = 0;
    const hostile = {
      [Symbol.toPrimitive]() {
        coercions += 1;
        throw new Error('coercion hook must not run');
      },
      valueOf() {
        coercions += 1;
        throw new Error('valueOf must not run');
      },
      toString() {
        coercions += 1;
        throw new Error('toString must not run');
      },
    };
    const instance = fakeInstance({
      unzen_array_f64_new: () => ({}),
      unzen_array_f64_set: () => { throw hostile; },
    });

    expect(() => marshalMoonBitArguments(
      instance,
      [[1]],
      { params: ['f64[]'] },
    )).toThrow('Unknown error');
    expect(coercions).toBe(0);
  });

  it('rejects an object result length without coercing it', () => {
    let coercions = 0;
    const hostileLength = {
      [Symbol.toPrimitive]() {
        coercions += 1;
        throw new Error('coercion hook must not run');
      },
      toString() {
        coercions += 1;
        throw new Error('toString must not run');
      },
    };
    const instance = fakeInstance({
      unzen_array_i32_length: () => hostileLength,
      unzen_array_i32_get: () => 0,
    });

    expect(() => unmarshalMoonBitResult(
      instance,
      {},
      { params: [], result: 'i32[]' },
    )).toThrow('invalid result length object');
    expect(coercions).toBe(0);
  });

  it('normalizes hostile result-copy failures and preserves ordinary messages', () => {
    const pair = Proxy.revocable({}, {});
    pair.revoke();
    const revokedInstance = fakeInstance({
      unzen_array_i32_length: () => 1,
      unzen_array_i32_get: () => { throw pair.proxy; },
    });
    expect(() => unmarshalMoonBitResult(
      revokedInstance,
      {},
      { params: [], result: 'i32[]' },
    )).toThrow('MoonBit i32[] bridge failed while copying result: Unknown error');

    const ordinaryInstance = fakeInstance({
      unzen_array_i32_length: () => { throw new Error('ordinary bridge failure'); },
      unzen_array_i32_get: () => 0,
    });
    expect(() => unmarshalMoonBitResult(
      ordinaryInstance,
      {},
      { params: [], result: 'i32[]' },
    )).toThrow('ordinary bridge failure');

    const primitiveInstance = fakeInstance({
      unzen_array_i32_length: () => { throw 'primitive bridge failure'; },
      unzen_array_i32_get: () => 0,
    });
    expect(() => unmarshalMoonBitResult(
      primitiveInstance,
      {},
      { params: [], result: 'i32[]' },
    )).toThrow('primitive bridge failure');
  });
});
