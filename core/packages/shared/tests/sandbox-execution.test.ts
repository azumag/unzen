import { describe, expect, it } from 'vitest';
import {
  SANDBOX_SYNCHRONOUS_EXECUTION,
  UNZEN_ASYNC_RESULT_ERROR,
  UNZEN_ITERATOR_RESULT_ERROR,
  assertSynchronousUnzenResult,
} from '../src/sandbox-execution';

describe('sandbox execution contract', () => {
  it('accepts materialized values', () => {
    expect(() => assertSynchronousUnzenResult(null)).not.toThrow();
    expect(() => assertSynchronousUnzenResult(42)).not.toThrow();
    expect(() => assertSynchronousUnzenResult({ value: 42 })).not.toThrow();
  });

  it('rejects Promise and thenable results', () => {
    expect(() => assertSynchronousUnzenResult(Promise.resolve(42)))
      .toThrow(UNZEN_ASYNC_RESULT_ERROR);
    expect(() => assertSynchronousUnzenResult({ then() {} }))
      .toThrow(UNZEN_ASYNC_RESULT_ERROR);
  });

  it('rejects iterator and generator results', () => {
    expect(() => assertSynchronousUnzenResult((function* () { yield 42; })()))
      .toThrow(UNZEN_ITERATOR_RESULT_ERROR);
    expect(() => assertSynchronousUnzenResult({ next() {} }))
      .toThrow(UNZEN_ITERATOR_RESULT_ERROR);
  });

  it('embeds both errors in the QuickJS execution expression', () => {
    expect(SANDBOX_SYNCHRONOUS_EXECUTION).toContain(UNZEN_ASYNC_RESULT_ERROR);
    expect(SANDBOX_SYNCHRONOUS_EXECUTION).toContain(UNZEN_ITERATOR_RESULT_ERROR);
  });
});
