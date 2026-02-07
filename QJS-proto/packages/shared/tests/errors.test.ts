/**
 * TDD tests for @unzen/shared error classes
 *
 * Test strategy:
 * - Verify error classes are properly hierarchical
 * - Verify error codes are correctly assigned
 * - Verify error messages are preserved
 * - Verify instanceof checks work correctly
 */

import { describe, it, expect } from 'vitest';
import {
  UnzenError,
  UnzenRuntimeError,
  UnzenFunctionError,
  UnzenNetworkError,
} from '../src/errors';

describe('UnzenError (base class)', () => {
  it('should create error with message and code', () => {
    const error = new UnzenError('Something went wrong', 'TEST_ERROR');

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(UnzenError);
    expect(error.message).toBe('Something went wrong');
    expect(error.code).toBe('TEST_ERROR');
    expect(error.name).toBe('UnzenError');
  });

  it('should have stack trace', () => {
    const error = new UnzenError('Test', 'TEST');

    expect(error.stack).toBeDefined();
    expect(typeof error.stack).toBe('string');
  });
});

describe('UnzenRuntimeError', () => {
  it('should extend UnzenError with correct code', () => {
    const error = new UnzenRuntimeError('Timeout exceeded');

    expect(error).toBeInstanceOf(UnzenError);
    expect(error).toBeInstanceOf(UnzenRuntimeError);
    expect(error.message).toBe('Timeout exceeded');
    expect(error.code).toBe('RUNTIME_ERROR');
    expect(error.name).toBe('UnzenRuntimeError');
  });

  it('should be catchable as UnzenError', () => {
    const error = new UnzenRuntimeError('Memory limit exceeded');

    try {
      throw error;
    } catch (e) {
      expect(e).toBeInstanceOf(UnzenError);
      if (e instanceof UnzenError) {
        expect(e.code).toBe('RUNTIME_ERROR');
      }
    }
  });
});

describe('UnzenFunctionError', () => {
  it('should extend UnzenError with correct code', () => {
    const error = new UnzenFunctionError('Invalid argument type');

    expect(error).toBeInstanceOf(UnzenError);
    expect(error).toBeInstanceOf(UnzenFunctionError);
    expect(error.message).toBe('Invalid argument type');
    expect(error.code).toBe('FUNCTION_ERROR');
    expect(error.name).toBe('UnzenFunctionError');
  });

  it('should be catchable as UnzenError', () => {
    const error = new UnzenFunctionError('Function execution failed');

    try {
      throw error;
    } catch (e) {
      expect(e).toBeInstanceOf(UnzenError);
      if (e instanceof UnzenError) {
        expect(e.code).toBe('FUNCTION_ERROR');
      }
    }
  });
});

describe('UnzenNetworkError', () => {
  it('should extend UnzenError with correct code', () => {
    const error = new UnzenNetworkError('Failed to fetch manifest');

    expect(error).toBeInstanceOf(UnzenError);
    expect(error).toBeInstanceOf(UnzenNetworkError);
    expect(error.message).toBe('Failed to fetch manifest');
    expect(error.code).toBe('NETWORK_ERROR');
    expect(error.name).toBe('UnzenNetworkError');
  });

  it('should be catchable as UnzenError', () => {
    const error = new UnzenNetworkError('Connection timeout');

    try {
      throw error;
    } catch (e) {
      expect(e).toBeInstanceOf(UnzenError);
      if (e instanceof UnzenError) {
        expect(e.code).toBe('NETWORK_ERROR');
      }
    }
  });
});

describe('Error handling patterns', () => {
  it('should allow discriminated union via code property', () => {
    const errors: UnzenError[] = [
      new UnzenRuntimeError('timeout'),
      new UnzenFunctionError('user error'),
      new UnzenNetworkError('fetch failed'),
    ];

    const runtimeErrors = errors.filter((e) => e.code === 'RUNTIME_ERROR');
    const functionErrors = errors.filter((e) => e.code === 'FUNCTION_ERROR');
    const networkErrors = errors.filter((e) => e.code === 'NETWORK_ERROR');

    expect(runtimeErrors).toHaveLength(1);
    expect(functionErrors).toHaveLength(1);
    expect(networkErrors).toHaveLength(1);
  });

  it('should allow instanceof checks for specific types', () => {
    const error = new UnzenFunctionError('test');

    expect(error instanceof UnzenFunctionError).toBe(true);
    expect(error instanceof UnzenRuntimeError).toBe(false);
    expect(error instanceof UnzenNetworkError).toBe(false);
    expect(error instanceof UnzenError).toBe(true);
    expect(error instanceof Error).toBe(true);
  });
});
