import { describe, expect, it } from 'vitest';
import { snapshotMoonBitCall, validateMoonBitArguments } from '../src/moonbit-array-bridge';
import { snapshotQuickJsCall } from '../src/quickjs-call';

function revokedArrayProxy(): unknown[] {
  const revoked = Proxy.revocable<unknown[]>([], {});
  revoked.revoke();
  return revoked.proxy;
}

function hostileThrownValue(onCoerce: () => void): object {
  return {
    toString() {
      onCoerce();
      throw new Error('must not stringify');
    },
    [Symbol.toPrimitive]() {
      onCoerce();
      throw new Error('must not coerce');
    },
  };
}

describe('Core client argument-container trust boundary', () => {
  it('fails closed on revoked QuickJS argument arrays', () => {
    expect(() => snapshotQuickJsCall('1 + 1', revokedArrayProxy()))
      .toThrow('QuickJS arguments must be an array');
  });

  it('fails closed on throwing QuickJS length/index reads without coercing thrown values', () => {
    let coercions = 0;
    const thrown = hostileThrownValue(() => { coercions += 1; });
    const lengthProxy = new Proxy<unknown[]>([1], {
      get(target, property, receiver) {
        if (property === 'length') throw thrown;
        return Reflect.get(target, property, receiver);
      },
    });
    const indexProxy = new Proxy<unknown[]>([1], {
      get(target, property, receiver) {
        if (property === '0') throw thrown;
        return Reflect.get(target, property, receiver);
      },
    });

    expect(() => snapshotQuickJsCall('1 + 1', lengthProxy))
      .toThrow('QuickJS arguments could not be read');
    expect(() => snapshotQuickJsCall('1 + 1', indexProxy))
      .toThrow('QuickJS arguments could not be read');
    expect(coercions).toBe(0);
  });

  it('reads QuickJS array length and numeric indexes once without invoking the iterator', () => {
    let lengthReads = 0;
    const indexReads = [0, 0];
    const source = [1, 2];
    Object.defineProperty(source, Symbol.iterator, {
      value: () => { throw new Error('iterator must not run'); },
    });
    const proxy = new Proxy(source, {
      get(target, property, receiver) {
        if (property === 'length') lengthReads += 1;
        if (property === '0') indexReads[0] += 1;
        if (property === '1') indexReads[1] += 1;
        return Reflect.get(target, property, receiver);
      },
    });

    expect(snapshotQuickJsCall('1 + 1', proxy).args).toEqual([1, 2]);
    expect(lengthReads).toBe(1);
    expect(indexReads).toEqual([1, 1]);
  });

  it('fails closed on revoked and throwing top-level MoonBit argument arrays', () => {
    expect(() => snapshotMoonBitCall(revokedArrayProxy()))
      .toThrow('MoonBit arguments must be an array');

    const lengthProxy = new Proxy<unknown[]>([1], {
      get(target, property, receiver) {
        if (property === 'length') throw new Error('caller length');
        return Reflect.get(target, property, receiver);
      },
    });
    const indexProxy = new Proxy<unknown[]>([1], {
      get(target, property, receiver) {
        if (property === '0') throw new Error('caller index');
        return Reflect.get(target, property, receiver);
      },
    });
    expect(() => snapshotMoonBitCall(lengthProxy))
      .toThrow('MoonBit arguments could not be read');
    expect(() => validateMoonBitArguments(indexProxy))
      .toThrow('MoonBit arguments could not be read');
  });

  it('fails closed on hostile nested MoonBit ABI arrays without coercing thrown values', () => {
    const revoked = revokedArrayProxy();
    expect(() => snapshotMoonBitCall([revoked], { params: ['i32[]'] }))
      .toThrow('expects i32[] (got object)');

    const lengthProxy = new Proxy<unknown[]>([1], {
      get(target, property, receiver) {
        if (property === 'length') throw new Error('caller length');
        return Reflect.get(target, property, receiver);
      },
    });
    expect(() => snapshotMoonBitCall([lengthProxy], { params: ['i32[]'] }))
      .toThrow('invalid array length');

    let coercions = 0;
    const thrown = hostileThrownValue(() => { coercions += 1; });
    const indexProxy = new Proxy<unknown[]>([1], {
      get(target, property, receiver) {
        if (property === '0') throw thrown;
        return Reflect.get(target, property, receiver);
      },
    });
    expect(() => snapshotMoonBitCall([indexProxy], { params: ['i32[]'] }))
      .toThrow('MoonBit ABI argument 0 could not be read');
    expect(coercions).toBe(0);
  });

  it('reads MoonBit top-level and nested containers once without invoking iterators', () => {
    let topLengthReads = 0;
    let topIndexReads = 0;
    let nestedLengthReads = 0;
    const nestedIndexReads = [0, 0];
    const nestedSource = [3, 4];
    Object.defineProperty(nestedSource, Symbol.iterator, {
      value: () => { throw new Error('nested iterator must not run'); },
    });
    const nested = new Proxy(nestedSource, {
      get(target, property, receiver) {
        if (property === 'length') nestedLengthReads += 1;
        if (property === '0') nestedIndexReads[0] += 1;
        if (property === '1') nestedIndexReads[1] += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    const topSource: unknown[] = [nested];
    Object.defineProperty(topSource, Symbol.iterator, {
      value: () => { throw new Error('top iterator must not run'); },
    });
    const top = new Proxy(topSource, {
      get(target, property, receiver) {
        if (property === 'length') topLengthReads += 1;
        if (property === '0') topIndexReads += 1;
        return Reflect.get(target, property, receiver);
      },
    });

    expect(snapshotMoonBitCall(top, { params: ['i32[]'] }).args).toEqual([[3, 4]]);
    expect(topLengthReads).toBe(1);
    expect(topIndexReads).toBe(1);
    expect(nestedLengthReads).toBe(1);
    expect(nestedIndexReads).toEqual([1, 1]);
  });

  it('formats a revoked MoonBit scalar argument without a native Proxy exception', () => {
    expect(() => snapshotMoonBitCall([revokedArrayProxy()]))
      .toThrow('arrays and objects cannot cross the wasm-gc boundary (got object)');
  });
});
