import { describe, expect, it } from 'vitest';
import {
  MAX_MOONBIT_ARRAY_ELEMENTS,
  MAX_MOONBIT_ARGUMENTS,
  MAX_MOONBIT_STRING_BYTES,
  marshalMoonBitArguments,
  snapshotMoonBitCall,
  unmarshalMoonBitResult,
  validateMoonBitArguments,
} from '../src/moonbit-array-bridge';

function fakeInstance(exports: Record<string, unknown>): WebAssembly.Instance {
  return { exports } as unknown as WebAssembly.Instance;
}

describe('MoonBit array bridge', () => {
  it('validates scalar, i32[], and f64[] arguments', () => {
    expect(() => validateMoonBitArguments(
      [[1, -2, 3], [1.5, Number.NaN], 'factor'],
      { params: ['i32[]', 'f64[]', 'scalar'] },
    )).not.toThrow();
  });

  it('rejects ABI mismatches and invalid numeric elements', () => {
    expect(() => validateMoonBitArguments([], { params: ['scalar'] }))
      .toThrow('expects 1 arguments, got 0');
    expect(() => validateMoonBitArguments([1], { params: ['i32[]'] }))
      .toThrow('expects i32[] (got number)');
    expect(() => validateMoonBitArguments([[1.5]], { params: ['i32[]'] }))
      .toThrow('must be a signed 32-bit integer');
    expect(() => validateMoonBitArguments([[2_147_483_648]], { params: ['i32[]'] }))
      .toThrow('must be a signed 32-bit integer');
    expect(() => validateMoonBitArguments([['1']], { params: ['f64[]'] }))
      .toThrow('must be a number');
  });

  it('rejects sparse and oversized arrays', () => {
    expect(() => validateMoonBitArguments([new Array(1)], { params: ['i32[]'] }))
      .toThrow('element 0 must be a signed 32-bit integer');
    expect(() => validateMoonBitArguments(
      [new Array(MAX_MOONBIT_ARRAY_ELEMENTS + 1).fill(0)],
      { params: ['i32[]'] },
    )).toThrow(`exceed ${MAX_MOONBIT_ARRAY_ELEMENTS}`);
  });

  it('rejects oversized inputs before invoking their iterator or allocating a copy', () => {
    const oversized = new Array(MAX_MOONBIT_ARRAY_ELEMENTS + 1);
    Object.defineProperty(oversized, Symbol.iterator, {
      value: () => { throw new Error('iterator must not run'); },
    });

    expect(() => snapshotMoonBitCall([oversized], { params: ['i32[]'] }))
      .toThrow(`exceed ${MAX_MOONBIT_ARRAY_ELEMENTS}`);
    expect(() => snapshotMoonBitCall(new Array(MAX_MOONBIT_ARGUMENTS + 1).fill(1)))
      .toThrow(`at most ${MAX_MOONBIT_ARGUMENTS} arguments`);
  });

  it('rejects a hostile Array Proxy length without coercing it', () => {
    const hostile = new Proxy<number[]>([], {
      get(target, property, receiver) {
        if (property === 'length') {
          return { valueOf: () => Number.POSITIVE_INFINITY };
        }
        return Reflect.get(target, property, receiver);
      },
    });

    expect(() => snapshotMoonBitCall([hostile], { params: ['i32[]'] }))
      .toThrow('invalid array length');
  });

  it('bounds aggregate scalar strings by their UTF-8 byte length', () => {
    const halfLimit = 'é'.repeat(MAX_MOONBIT_STRING_BYTES / 4);

    expect(snapshotMoonBitCall(
      [halfLimit, halfLimit],
      { params: ['scalar', 'scalar'] },
    ).args).toEqual([halfLimit, halfLimit]);
    expect(() => snapshotMoonBitCall([halfLimit, `${halfLimit}x`]))
      .toThrow(`exceed ${MAX_MOONBIT_STRING_BYTES} total UTF-8 bytes`);
  });

  it('snapshots ABI metadata and array arguments against caller mutation', () => {
    const values = [1, 2, 3];
    const abi = { params: ['i32[]'] as ('i32[]' | 'scalar')[], result: 'i32[]' as const };
    const snapshot = snapshotMoonBitCall([values], abi);

    values[0] = 99;
    abi.params[0] = 'scalar';
    expect(snapshot.args).toEqual([[1, 2, 3]]);
    expect(snapshot.args[0]).not.toBe(values);
    expect(snapshot.abi).toEqual({ params: ['i32[]'], result: 'i32[]' });
    expect(snapshot.abi?.params).not.toBe(abi.params);
  });

  it('requires the standard bridge exports', () => {
    expect(() => marshalMoonBitArguments(
      fakeInstance({}),
      [[1, 2]],
      { params: ['i32[]'] },
    )).toThrow('unzen_array_i32_new');
  });

  it('rejects unsafe result lengths before allocating a JS array', () => {
    const instance = fakeInstance({
      unzen_array_i32_length: () => MAX_MOONBIT_ARRAY_ELEMENTS + 1,
      unzen_array_i32_get: () => 0,
    });
    expect(() => unmarshalMoonBitResult(
      instance,
      {},
      { params: [], result: 'i32[]' },
    )).toThrow('invalid result length');
  });

  it('rejects oversized scalar string results', () => {
    const oversized = `${'é'.repeat(MAX_MOONBIT_STRING_BYTES / 2)}x`;

    expect(() => unmarshalMoonBitResult(fakeInstance({}), oversized))
      .toThrow(`exceeds ${MAX_MOONBIT_STRING_BYTES} UTF-8 bytes`);
  });
});
