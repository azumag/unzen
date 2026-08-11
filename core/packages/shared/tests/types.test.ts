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
  isValidContentHash,
  isValidFunctionName,
  isRuntimeType,
  MAX_FUNCTION_PAYLOAD_BYTES,
  MAX_MOONBIT_ABI_PARAMS,
  normalizeMoonBitAbi,
  normalizeFunctionDefinition,
  isValidMoonBitAbi,
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

describe('shared identifier validation', () => {
  it('accepts only safe manifest function names', () => {
    expect(isValidFunctionName('calculate-total_2')).toBe(true);
    expect(isValidFunctionName('2calculate')).toBe(false);
    expect(isValidFunctionName('../calculate')).toBe(false);
  });

  it('accepts only canonical lowercase SHA-256 identities', () => {
    const hash = `sha256:${'a'.repeat(64)}`;
    expect(isValidContentHash(hash)).toBe(true);
    expect(isValidContentHash(hash.toUpperCase())).toBe(false);
    expect(isValidContentHash('sha256:abc')).toBe(false);
  });
});

describe('MoonBitAbi', () => {
  it('accepts scalar/i32/f64 signatures', () => {
    expect(isValidMoonBitAbi({
      params: ['i32[]', 'scalar'],
      result: 'f64[]',
    })).toBe(true);
    expect(isValidMoonBitAbi({ params: [] })).toBe(true);
  });

  it('rejects invalid, sparse, and oversized metadata', () => {
    expect(isValidMoonBitAbi({ params: ['u32[]'] })).toBe(false);
    expect(isValidMoonBitAbi({ params: new Array(1) })).toBe(false);
    expect(isValidMoonBitAbi({
      params: new Array(MAX_MOONBIT_ABI_PARAMS + 1).fill('scalar'),
    })).toBe(false);
    expect(isValidMoonBitAbi({ params: [], result: 'object' })).toBe(false);
  });

  it('normalizes params by bounded index without invoking a custom iterator', () => {
    const params = ['i32[]', 'scalar'];
    Object.defineProperty(params, Symbol.iterator, {
      value: () => { throw new Error('iterator must not run'); },
    });

    expect(normalizeMoonBitAbi({ params, result: 'f64[]' })).toEqual({
      params: ['i32[]', 'scalar'],
      result: 'f64[]',
    });
    expect(isValidMoonBitAbi({ params })).toBe(true);
  });
});

describe('FunctionDefinition', () => {
  describe('validation', () => {
    // Valid SHA-256 hash: 64 hex characters after 'sha256:' prefix
    const validDefinition: FunctionDefinition = {
      name: 'testFunction',
      runtime: 'quickjs',
      code: 'return args[0] * 2',
      version: 1,
      hash: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    };

    it('should accept valid function definitions', () => {
      expect(isValidFunctionDefinition(validDefinition)).toBe(true);
    });

    it('normalizes an isolated definition snapshot', () => {
      const params = ['i32[]'] as const;
      const source = {
        ...validDefinition,
        runtime: 'moonbit' as const,
        exportName: 'double_values',
        moonbitAbi: { params: [...params], result: 'i32[]' as const },
        noFallback: true,
        ignoredFutureField: true,
      };

      const normalized = normalizeFunctionDefinition(source);
      expect(normalized).toEqual({
        ...validDefinition,
        runtime: 'moonbit',
        exportName: 'double_values',
        moonbitAbi: { params: ['i32[]'], result: 'i32[]' },
        noFallback: true,
      });
      expect(normalized?.moonbitAbi?.params).not.toBe(source.moonbitAbi.params);
    });

    it.each([
      ['non-boolean noFallback', { noFallback: 'yes' }],
      ['QuickJS exportName', { exportName: 'run' }],
      ['non-string MoonBit exportName', { runtime: 'moonbit', exportName: 42 }],
    ])('rejects %s metadata', (_label, invalid) => {
      expect(normalizeFunctionDefinition({ ...validDefinition, ...invalid }))
        .toBeUndefined();
    });

    it('should reject definitions without required fields', () => {
      expect(isValidFunctionDefinition({} as FunctionDefinition)).toBe(false);
      expect(isValidFunctionDefinition({ ...validDefinition, name: '' })).toBe(false);
      expect(isValidFunctionDefinition({ ...validDefinition, code: '' })).toBe(false);
    });

    it('enforces the function code limit by UTF-8 byte length', () => {
      const exactLimit = '\u00e9'.repeat(MAX_FUNCTION_PAYLOAD_BYTES / 2);

      expect(normalizeFunctionDefinition({
        ...validDefinition,
        code: exactLimit,
      })).toBeDefined();
      expect(normalizeFunctionDefinition({
        ...validDefinition,
        code: `${exactLimit}x`,
      })).toBeUndefined();
    });

    it('should reject definitions with invalid runtime type', () => {
      const invalidRuntime = { ...validDefinition, runtime: 'invalid' as RuntimeType };
      expect(isValidFunctionDefinition(invalidRuntime)).toBe(false);
    });

    it('accepts MoonBit ABI only on valid MoonBit definitions', () => {
      const moonbitDefinition: FunctionDefinition = {
        ...validDefinition,
        runtime: 'moonbit',
        moonbitAbi: { params: ['i32[]'], result: 'scalar' },
      };
      expect(isValidFunctionDefinition(moonbitDefinition)).toBe(true);
      expect(isValidFunctionDefinition({
        ...validDefinition,
        moonbitAbi: { params: ['i32[]'] },
      })).toBe(false);
      expect(isValidFunctionDefinition({
        ...moonbitDefinition,
        moonbitAbi: { params: ['bad'] },
      })).toBe(false);
    });

    it('should reject definitions with invalid version', () => {
      expect(isValidFunctionDefinition({ ...validDefinition, version: 0 })).toBe(false);
      expect(isValidFunctionDefinition({ ...validDefinition, version: -1 })).toBe(false);
      // Non-integer versions must be rejected (cache invalidation relies on integer comparison)
      expect(isValidFunctionDefinition({ ...validDefinition, version: 1.5 })).toBe(false);
      expect(isValidFunctionDefinition({
        ...validDefinition,
        version: Number.MAX_SAFE_INTEGER + 1,
      })).toBe(false);
    });

    it('should reject definitions with invalid hash format', () => {
      expect(isValidFunctionDefinition({ ...validDefinition, hash: '' })).toBe(false);
      // Hash must be sha256: followed by exactly 64 hex characters
      expect(isValidFunctionDefinition({ ...validDefinition, hash: 'not-a-hash' })).toBe(false);
      expect(isValidFunctionDefinition({ ...validDefinition, hash: 'sha256:' })).toBe(false);
      expect(isValidFunctionDefinition({ ...validDefinition, hash: 'sha256:abc123' })).toBe(false);
      expect(isValidFunctionDefinition({ ...validDefinition, hash: 'sha256:zzzz' })).toBe(false);
    });

    it('should reject function names with path traversal characters', () => {
      // Function names appear in URL paths (/code/:name) — must be safe
      expect(isValidFunctionDefinition({ ...validDefinition, name: '../../etc/passwd' })).toBe(false);
      expect(isValidFunctionDefinition({ ...validDefinition, name: '../evil' })).toBe(false);
      expect(isValidFunctionDefinition({ ...validDefinition, name: 'foo/bar' })).toBe(false);
    });

    it('should reject function names starting with non-letter', () => {
      // Function names must start with a letter (convention consistency)
      expect(isValidFunctionDefinition({ ...validDefinition, name: '123abc' })).toBe(false);
      expect(isValidFunctionDefinition({ ...validDefinition, name: '_private' })).toBe(false);
    });

    describe('timeout validation', () => {
      it('should accept definition without timeout (undefined)', () => {
        expect(isValidFunctionDefinition(validDefinition)).toBe(true);
      });

      it('should accept valid timeout values', () => {
        expect(isValidFunctionDefinition({ ...validDefinition, timeout: 1 })).toBe(true);
        expect(isValidFunctionDefinition({ ...validDefinition, timeout: 50 })).toBe(true);
        expect(isValidFunctionDefinition({ ...validDefinition, timeout: 500 })).toBe(true);
        expect(isValidFunctionDefinition({ ...validDefinition, timeout: 2000 })).toBe(true);
      });

      it('should reject timeout <= 0', () => {
        expect(isValidFunctionDefinition({ ...validDefinition, timeout: 0 })).toBe(false);
        expect(isValidFunctionDefinition({ ...validDefinition, timeout: -1 })).toBe(false);
      });

      it('should reject timeout > 2000', () => {
        expect(isValidFunctionDefinition({ ...validDefinition, timeout: 2001 })).toBe(false);
        expect(isValidFunctionDefinition({ ...validDefinition, timeout: 10000 })).toBe(false);
      });

      it('should reject non-integer timeout', () => {
        expect(isValidFunctionDefinition({ ...validDefinition, timeout: 50.5 })).toBe(false);
      });

      it('should reject NaN and Infinity timeout', () => {
        expect(isValidFunctionDefinition({ ...validDefinition, timeout: NaN })).toBe(false);
        expect(isValidFunctionDefinition({ ...validDefinition, timeout: Infinity })).toBe(false);
      });
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
