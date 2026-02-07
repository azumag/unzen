/**
 * TDD tests for @unzen/shared types
 *
 * Test strategy:
 * - Verify type definitions are properly exported
 * - Verify type guard functions work correctly
 * - Verify runtime type checking for function definitions
 */

import { describe, it, expect } from 'vitest';
import {
  RuntimeType,
  FunctionDefinition,
  ExecutionOptions,
  ExecutionResult,
  isRuntimeType,
  isValidFunctionDefinition,
} from '../src/types';

describe('RuntimeType', () => {
  describe('type guard', () => {
    it('should return true for valid runtime types', () => {
      expect(isRuntimeType('quickjs')).toBe(true);
      expect(isRuntimeType('moonbit')).toBe(true);
    });

    it('should return false for invalid runtime types', () => {
      expect(isRuntimeType('v8')).toBe(false);
      expect(isRuntimeType('')).toBe(false);
      expect(isRuntimeType('javascript')).toBe(false);
      expect(isRuntimeType(undefined as unknown as string)).toBe(false);
    });
  });
});

describe('FunctionDefinition', () => {
  describe('validation', () => {
    const validDefinition: FunctionDefinition = {
      name: 'testFunction',
      runtime: 'quickjs',
      code: 'return args[0] * 2',
      version: 1,
      hash: 'sha256:abc123',
    };

    it('should accept valid function definitions', () => {
      expect(isValidFunctionDefinition(validDefinition)).toBe(true);
    });

    it('should reject definitions without required fields', () => {
      expect(isValidFunctionDefinition({} as FunctionDefinition)).toBe(false);
      expect(isValidFunctionDefinition({ ...validDefinition, name: '' })).toBe(false);
      expect(isValidFunctionDefinition({ ...validDefinition, code: '' })).toBe(false);
    });

    it('should reject definitions with invalid runtime type', () => {
      const invalidRuntime = { ...validDefinition, runtime: 'invalid' as RuntimeType };
      expect(isValidFunctionDefinition(invalidRuntime)).toBe(false);
    });

    it('should reject definitions with invalid version', () => {
      expect(isValidFunctionDefinition({ ...validDefinition, version: 0 })).toBe(false);
      expect(isValidFunctionDefinition({ ...validDefinition, version: -1 })).toBe(false);
    });

    it('should reject definitions with empty hash', () => {
      expect(isValidFunctionDefinition({ ...validDefinition, hash: '' })).toBe(false);
    });
  });
});

describe('ExecutionOptions', () => {
  it('should accept partial options', () => {
    const options1: ExecutionOptions = {};
    const options2: ExecutionOptions = { timeout: 100 };
    const options3: ExecutionOptions = { diagnostics: true };
    const options4: ExecutionOptions = { mode: 'development' };

    expect(options1).toBeDefined();
    expect(options2.timeout).toBe(100);
    expect(options3.diagnostics).toBe(true);
    expect(options4.mode).toBe('development');
  });

  it('should accept all options', () => {
    const options: ExecutionOptions = {
      timeout: 50,
      diagnostics: true,
      mode: 'production',
    };

    expect(options.timeout).toBe(50);
    expect(options.diagnostics).toBe(true);
    expect(options.mode).toBe('production');
  });

  it('should only accept valid mode values', () => {
    const validModes: Array<ExecutionOptions['mode']> = ['production', 'development', 'browser-only'];

    validModes.forEach((mode) => {
      const options: ExecutionOptions = { mode };
      expect(options.mode).toBe(mode);
    });
  });
});

describe('ExecutionResult', () => {
  it('should create result with all fields', () => {
    const result: ExecutionResult<number> = {
      value: 42,
      executedOn: 'browser',
      runtime: 'quickjs',
      durationMs: 10,
      cached: false,
    };

    expect(result.value).toBe(42);
    expect(result.executedOn).toBe('browser');
    expect(result.runtime).toBe('quickjs');
    expect(result.durationMs).toBe(10);
    expect(result.cached).toBe(false);
  });

  it('should allow unknown value type by default', () => {
    const result1: ExecutionResult = { value: 'string', executedOn: 'server', runtime: 'quickjs', durationMs: 5, cached: true };
    const result2: ExecutionResult = { value: { key: 'val' }, executedOn: 'browser', runtime: 'moonbit', durationMs: 15, cached: false };
    const result3: ExecutionResult = { value: [1, 2, 3], executedOn: 'server', runtime: 'quickjs', durationMs: 8, cached: true };

    expect(result1.value).toBe('string');
    expect(result2.value).toEqual({ key: 'val' });
    expect(result3.value).toEqual([1, 2, 3]);
  });
});
