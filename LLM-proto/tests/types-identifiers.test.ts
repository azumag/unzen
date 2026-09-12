import { describe, expect, it } from 'vitest';
import { inferenceRequestId, workerId } from '../src/types.js';

describe('branded identifier constructors', () => {
  it('preserves non-empty worker and request identifiers exactly', () => {
    expect(workerId('worker-01')).toBe('worker-01');
    expect(inferenceRequestId(' request-with-padding ')).toBe(' request-with-padding ');
  });

  it('rejects empty and whitespace-only worker identifiers', () => {
    expect(() => workerId('')).toThrow(/workerId must be a non-empty string/);
    expect(() => workerId('   \t\n')).toThrow(/workerId must be a non-empty string/);
  });

  it('rejects empty and whitespace-only inference request identifiers', () => {
    expect(() => inferenceRequestId('')).toThrow(/inferenceRequestId must be a non-empty string/);
    expect(() => inferenceRequestId('   \t\n')).toThrow(
      /inferenceRequestId must be a non-empty string/,
    );
  });

  it('rejects non-string runtime worker identifiers before branding', () => {
    const malformedValues: readonly unknown[] = [
      null,
      undefined,
      123,
      true,
      [],
      {},
      Symbol('worker'),
      { trim: () => 'spoofed-worker' },
    ];

    for (const value of malformedValues) {
      expect(() => workerId(value as string)).toThrow(/workerId must be a non-empty string/);
    }
  });

  it('rejects non-string runtime request identifiers before branding', () => {
    const malformedValues: readonly unknown[] = [
      null,
      undefined,
      123,
      false,
      [],
      {},
      Symbol('request'),
      { trim: () => 'spoofed-request' },
    ];

    for (const value of malformedValues) {
      expect(() => inferenceRequestId(value as string)).toThrow(
        /inferenceRequestId must be a non-empty string/,
      );
    }
  });
});
