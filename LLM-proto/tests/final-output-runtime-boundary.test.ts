import { describe, expect, it } from 'vitest';
import { snapshotFinalOutput } from '../src/final-output-snapshot.js';

const hostileThrownValue = {
  toString(): string {
    throw new Error('hostile thrown value must not be stringified');
  },
  [Symbol.toPrimitive](): never {
    throw new Error('hostile thrown value must not be coerced');
  },
};

const makeError = (message: string): Error => new TypeError(message);

describe('final output hostile runtime boundary', () => {
  it('fails closed on a revoked final-output proxy', () => {
    const revoked = Proxy.revocable({ tokens: [1], text: 'ok' }, {});
    revoked.revoke();

    expect(() => snapshotFinalOutput(
      revoked.proxy,
      makeError,
      'final segment output',
    )).toThrow(/final segment output must be a non-null, non-array object/);
  });

  it('maps throwing output field getters without inspecting the thrown value', () => {
    const throwingTokens = new Proxy({ tokens: [1], text: 'ok' }, {
      get(target, property, receiver) {
        if (property === 'tokens') throw hostileThrownValue;
        return Reflect.get(target, property, receiver);
      },
    });
    expect(() => snapshotFinalOutput(
      throwingTokens,
      makeError,
      'final segment output',
    )).toThrow(/final segment output tokens must be an array/);

    const throwingText = new Proxy({ tokens: [1], text: 'ok' }, {
      get(target, property, receiver) {
        if (property === 'text') throw hostileThrownValue;
        return Reflect.get(target, property, receiver);
      },
    });
    expect(() => snapshotFinalOutput(
      throwingText,
      makeError,
      'final span output',
    )).toThrow(/final span output text must be a string/);
  });

  it('fails closed on revoked and hostile token arrays', () => {
    const revoked = Proxy.revocable([1], {});
    revoked.revoke();
    expect(() => snapshotFinalOutput(
      { tokens: revoked.proxy, text: 'ok' },
      makeError,
      'final segment output',
    )).toThrow(/final segment output tokens must be an array/);

    const throwingLength = new Proxy([1], {
      get(target, property, receiver) {
        if (property === 'length') throw hostileThrownValue;
        return Reflect.get(target, property, receiver);
      },
    });
    expect(() => snapshotFinalOutput(
      { tokens: throwingLength, text: 'ok' },
      makeError,
      'final segment output',
    )).toThrow(/final segment output tokens must be an array/);

    const impossibleLength = new Proxy([1], {
      get(target, property, receiver) {
        if (property === 'length') return Number.MAX_SAFE_INTEGER;
        return Reflect.get(target, property, receiver);
      },
    });
    expect(() => snapshotFinalOutput(
      { tokens: impossibleLength, text: 'ok' },
      makeError,
      'final segment output',
    )).toThrow(/final segment output tokens must be an array/);

    const throwingIndex = new Proxy([1], {
      get(target, property, receiver) {
        if (property === '0') throw hostileThrownValue;
        return Reflect.get(target, property, receiver);
      },
    });
    expect(() => snapshotFinalOutput(
      { tokens: throwingIndex, text: 'ok' },
      makeError,
      'final segment output',
    )).toThrow(/final segment output tokens must contain non-negative safe integers/);
  });

  it('captures fields, array length, and token slots once without using an iterator', () => {
    const outputReads = new Map<PropertyKey, number>();
    const tokenReads = new Map<PropertyKey, number>();
    const tokens = new Proxy([7, 8], {
      get(target, property, receiver) {
        if (property === Symbol.iterator) {
          throw new Error('worker token iterator must not run');
        }
        if (property === 'length' || property === '0' || property === '1') {
          tokenReads.set(property, (tokenReads.get(property) ?? 0) + 1);
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const output = new Proxy({ tokens, text: 'stable' }, {
      get(target, property, receiver) {
        if (property === 'tokens' || property === 'text') {
          outputReads.set(property, (outputReads.get(property) ?? 0) + 1);
        }
        return Reflect.get(target, property, receiver);
      },
    });

    const snapshot = snapshotFinalOutput(output, makeError, 'final segment output');

    expect(snapshot).toEqual({ tokens: [7, 8], text: 'stable' });
    expect(outputReads.get('tokens')).toBe(1);
    expect(outputReads.get('text')).toBe(1);
    expect(tokenReads.get('length')).toBe(1);
    expect(tokenReads.get('0')).toBe(1);
    expect(tokenReads.get('1')).toBe(1);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.tokens)).toBe(true);
  });
});
