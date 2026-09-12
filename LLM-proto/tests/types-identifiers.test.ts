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
});
