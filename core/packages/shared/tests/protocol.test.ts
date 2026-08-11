/**
 * TDD tests for @unzen/shared protocol types
 *
 * Test strategy:
 * - Verify protocol types are properly structured
 * - Verify serialization/deserialization works
 * - Verify type safety for protocol messages
 */

import { describe, it, expect } from 'vitest';
import {
  ManifestRequest,
  ManifestResponse,
  FunctionManifestEntry,
  ExecutionRequest,
  ExecutionResponse,
  MAX_MANIFEST_RESPONSE_BYTES,
  createManifestResponse,
  createExecutionResponse,
  isValidManifestResponse,
  isValidExecutionResponse,
  normalizeExecutionResponse,
  normalizeManifestResponse,
} from '../src/protocol';
import { RuntimeType } from '../src/types';

const VALID_HASH = `sha256:${'a'.repeat(64)}`;
const VALID_HASH_B = `sha256:${'b'.repeat(64)}`;

describe('ManifestRequest', () => {
  it('should be an empty object (no parameters needed)', () => {
    const request: ManifestRequest = {};

    expect(request).toEqual({});
  });
});

describe('FunctionManifestEntry', () => {
  it('should accept valid entry', () => {
    const entry: FunctionManifestEntry = {
      runtime: 'quickjs',
      hash: 'sha256:abc123',
      version: 1,
      codeUrl: '/unzen/code/testFn?v=1',
    };

    expect(entry.runtime).toBe('quickjs');
    expect(entry.hash).toBe('sha256:abc123');
    expect(entry.version).toBe(1);
    expect(entry.codeUrl).toBe('/unzen/code/testFn?v=1');
  });

  it('should accept moonbit runtime', () => {
    const entry: FunctionManifestEntry = {
      runtime: 'moonbit',
      hash: 'sha256:def456',
      version: 2,
      codeUrl: '/unzen/wasm/stats.wasm?v=2',
    };

    expect(entry.runtime).toBe('moonbit');
  });
});

describe('ManifestResponse', () => {
  it('should group functions by name', () => {
    const response: ManifestResponse = {
      functions: {
        spamCheck: {
          runtime: 'quickjs',
          hash: 'sha256:abc123',
          version: 1,
          codeUrl: '/unzen/code/spamCheck?v=1',
        },
        calculateMean: {
          runtime: 'moonbit',
          hash: 'sha256:def456',
          version: 1,
          codeUrl: '/unzen/wasm/stats.wasm?v=1',
        },
      },
    };

    expect(Object.keys(response.functions)).toHaveLength(2);
    expect(response.functions.spamCheck.runtime).toBe('quickjs');
    expect(response.functions.calculateMean.runtime).toBe('moonbit');
  });

  it('normalizes a valid manifest into an isolated prototype-safe snapshot', () => {
    const sourceParams = ['i32[]', 'scalar'];
    const source = {
      functions: {
        add: {
          runtime: 'quickjs',
          hash: VALID_HASH,
          version: 1,
          codeUrl: '/unzen/code/add',
          noFallback: true,
          ignoredFutureField: 'ignored',
        },
        sumArray: {
          runtime: 'moonbit',
          hash: `sha256:${'b'.repeat(64)}`,
          version: 2,
          codeUrl: 'https://cdn.example.com/sum.wasm',
          exportName: 'sum_array',
          moonbitAbi: { params: sourceParams, result: 'scalar' },
        },
      },
    };

    const normalized = normalizeManifestResponse(source);

    expect(normalized).toEqual({
      functions: {
        add: {
          runtime: 'quickjs',
          hash: VALID_HASH,
          version: 1,
          codeUrl: '/unzen/code/add',
          noFallback: true,
        },
        sumArray: {
          runtime: 'moonbit',
          hash: `sha256:${'b'.repeat(64)}`,
          version: 2,
          codeUrl: 'https://cdn.example.com/sum.wasm',
          exportName: 'sum_array',
          moonbitAbi: { params: ['i32[]', 'scalar'], result: 'scalar' },
        },
      },
    });
    expect(Object.getPrototypeOf(normalized!.functions)).toBeNull();
    expect(normalized!.functions.toString).toBeUndefined();
    expect(normalized!.functions.sumArray.moonbitAbi?.params).not.toBe(sourceParams);
    expect(isValidManifestResponse(source)).toBe(true);
  });

  it.each([
    ['missing root object', null],
    ['missing functions record', {}],
    ['array functions record', { functions: [] }],
    ['Map functions record', { functions: new Map() }],
    ['unsafe function name', { functions: { '../escape': {} } }],
  ])('rejects %s', (_label, value) => {
    expect(normalizeManifestResponse(value)).toBeUndefined();
    expect(isValidManifestResponse(value)).toBe(false);
  });

  it.each([
    ['invalid runtime', { runtime: 'v8' }],
    ['invalid hash', { hash: 'sha256:abc' }],
    ['invalid version', { version: Number.MAX_SAFE_INTEGER + 1 }],
    ['unsafe code URL', { codeUrl: 'data:text/javascript,alert(1)' }],
    ['quickjs export metadata', { exportName: 'run' }],
    ['quickjs MoonBit ABI', { moonbitAbi: { params: [] } }],
    ['invalid noFallback', { noFallback: 'yes' }],
  ])('rejects an entry with %s', (_label, invalid) => {
    const entry = {
      runtime: 'quickjs',
      hash: VALID_HASH,
      version: 1,
      codeUrl: '/unzen/code/add',
      ...invalid,
    };
    const value = { functions: { add: entry } };
    expect(normalizeManifestResponse(value)).toBeUndefined();
    expect(isValidManifestResponse(value)).toBe(false);
  });

  it('rejects malformed MoonBit metadata', () => {
    const base = {
      runtime: 'moonbit',
      hash: VALID_HASH,
      version: 1,
      codeUrl: '/unzen/code/sum.wasm',
    };

    expect(normalizeManifestResponse({
      functions: { sum: { ...base, moonbitAbi: { params: ['object'] } } },
    })).toBeUndefined();
    expect(normalizeManifestResponse({
      functions: { sum: { ...base, exportName: 42 } },
    })).toBeUndefined();
  });

  it('rejects non-record entries and hostile accessors without throwing', () => {
    expect(normalizeManifestResponse({
      functions: { add: new Date() },
    })).toBeUndefined();

    const hostile = {};
    Object.defineProperty(hostile, 'functions', {
      get: () => { throw new Error('getter must be contained'); },
    });
    expect(() => normalizeManifestResponse(hostile)).not.toThrow();
    expect(normalizeManifestResponse(hostile)).toBeUndefined();
  });
});

describe('ExecutionRequest', () => {
  it('should accept array of arguments', () => {
    const request: ExecutionRequest = {
      args: ['hello', 42, true, { key: 'value' }],
    };

    expect(request.args).toHaveLength(4);
    expect(request.args[0]).toBe('hello');
    expect(request.args[1]).toBe(42);
    expect(request.args[2]).toBe(true);
    expect(request.args[3]).toEqual({ key: 'value' });
  });

  it('should accept empty args array', () => {
    const request: ExecutionRequest = {
      args: [],
    };

    expect(request.args).toEqual([]);
  });
});

describe('ExecutionResponse', () => {
  it('should contain result on success', () => {
    const response: ExecutionResponse = {
      result: 42,
    };

    expect(response.result).toBe(42);
    expect(response.error).toBeUndefined();
  });

  it('should contain error on failure', () => {
    const response: ExecutionResponse = {
      result: null,
      error: 'Function execution failed',
    };

    expect(response.result).toBeNull();
    expect(response.error).toBe('Function execution failed');
  });

  it('should have null result when error exists', () => {
    const response: ExecutionResponse = {
      result: null,
      error: 'Timeout exceeded',
    };

    expect(response.error).toBeDefined();
  });

  it('normalizes success, failure, and legacy undefined success envelopes', () => {
    expect(normalizeExecutionResponse({ result: 0 })).toEqual({ result: 0 });
    expect(normalizeExecutionResponse({
      result: null,
      error: 'Function failed',
      ignoredFutureField: true,
    })).toEqual({ result: null, error: 'Function failed' });
    // JSON.stringify omits an undefined result from the current server
    // envelope, so an empty object remains the wire representation of a
    // successful undefined return value.
    expect(normalizeExecutionResponse({})).toEqual({ result: undefined });
    expect(isValidExecutionResponse({ result: false })).toBe(true);
  });

  it.each([
    ['null', null],
    ['array', []],
    ['primitive', 'result'],
    ['empty error', { result: null, error: '' }],
    ['blank error', { result: null, error: '   ' }],
    ['non-string error', { result: null, error: 42 }],
    ['error without null result', { error: 'failed' }],
    ['conflicting result and error', { result: 42, error: 'failed' }],
    ['unknown-only success', { status: 'ok' }],
  ])('rejects an invalid %s envelope', (_label, value) => {
    expect(normalizeExecutionResponse(value)).toBeUndefined();
    expect(isValidExecutionResponse(value)).toBe(false);
  });

  it('contains hostile response accessors without throwing', () => {
    const hostile = {};
    Object.defineProperty(hostile, 'error', {
      enumerable: true,
      get: () => { throw new Error('getter must be contained'); },
    });

    expect(() => normalizeExecutionResponse(hostile)).not.toThrow();
    expect(normalizeExecutionResponse(hostile)).toBeUndefined();
  });
});

describe('createManifestResponse', () => {
  it('should create response from function definitions', () => {
    const functions = {
      spamCheck: {
        name: 'spamCheck',
        runtime: 'quickjs' as RuntimeType,
        code: 'return /spam/i.test(args[0])',
        version: 1,
        hash: VALID_HASH,
      },
    };

    const response = createManifestResponse(functions, 'https://example.com/unzen');

    expect(response.functions.spamCheck.runtime).toBe('quickjs');
    expect(response.functions.spamCheck.hash).toBe(VALID_HASH);
    expect(response.functions.spamCheck.version).toBe(1);
    expect(response.functions.spamCheck.codeUrl).toBe(
      `https://example.com/unzen/code/spamCheck?v=1&h=${encodeURIComponent(VALID_HASH)}`,
    );
  });

  it('should handle empty function list', () => {
    const response = createManifestResponse({}, 'https://example.com/unzen');

    expect(response.functions).toEqual({});
  });

  it('keeps cache URLs unique when a restarted server reuses a version number', () => {
    const definition = {
      name: 'calculate',
      runtime: 'quickjs' as RuntimeType,
      code: 'function run() {}',
      version: 1,
      hash: VALID_HASH,
    };
    const first = createManifestResponse({ calculate: definition }, '/unzen');
    const second = createManifestResponse({
      calculate: { ...definition, hash: VALID_HASH_B },
    }, '/unzen');

    expect(first.functions.calculate.codeUrl).not.toBe(second.functions.calculate.codeUrl);
    expect(first.functions.calculate.codeUrl)
      .toContain(`v=1&h=${encodeURIComponent(VALID_HASH)}`);
    expect(second.functions.calculate.codeUrl)
      .toContain(`v=1&h=${encodeURIComponent(VALID_HASH_B)}`);
  });

  it('copies MoonBit ABI metadata into the manifest', () => {
    const abi = { params: ['f64[]', 'scalar'] as const, result: 'f64[]' as const };
    const sourceParams = [...abi.params];
    Object.defineProperty(sourceParams, Symbol.iterator, {
      value: () => { throw new Error('iterator must not run'); },
    });
    const sourceAbi = { params: sourceParams, result: abi.result };
    const response = createManifestResponse({
      scale: {
        name: 'scale',
        runtime: 'moonbit',
        code: 'scale.wasm',
        version: 1,
        hash: VALID_HASH,
        moonbitAbi: sourceAbi,
      },
    }, 'https://example.com/unzen');

    expect(response.functions.scale.moonbitAbi).toEqual(abi);
    expect(response.functions.scale.moonbitAbi).not.toBe(sourceAbi);
    expect(response.functions.scale.moonbitAbi?.params).not.toBe(sourceParams);
  });

  it('normalizes the base URL and returns a prototype-safe function table', () => {
    const response = createManifestResponse({
      calculate: {
        name: 'calculate',
        runtime: 'quickjs',
        code: 'function run() { return 1; }',
        version: 1,
        hash: VALID_HASH,
      },
    }, '  /api/../unzen///  ');

    expect(Object.getPrototypeOf(response.functions)).toBeNull();
    expect(response.functions.calculate.codeUrl)
      .toBe(`/unzen/code/calculate?v=1&h=${encodeURIComponent(VALID_HASH)}`);
  });

  it('serializes the same function set independently of record insertion order', () => {
    const alpha = {
      name: 'alpha',
      runtime: 'quickjs' as const,
      code: 'function run() { return 1; }',
      version: 1,
      hash: VALID_HASH,
    };
    const zulu = {
      ...alpha,
      name: 'zulu',
      version: 2,
      hash: VALID_HASH_B,
    };

    const first = createManifestResponse({ zulu, alpha }, '/unzen');
    const second = createManifestResponse({ alpha, zulu }, '/unzen');

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(Object.keys(first.functions)).toEqual(['alpha', 'zulu']);
  });

  it.each([
    'relative/path',
    '//attacker.example/unzen',
    'javascript:alert(1)',
    'https://user:secret@example.com/unzen',
    'https://example.com/unzen?tenant=1',
    'https://example.com/unzen#fragment',
  ])('rejects unsafe manifest base URL %j', (baseUrl) => {
    expect(() => createManifestResponse({}, baseUrl)).toThrow('baseUrl');
  });

  it('rejects invalid or mismatched function definitions', () => {
    const definition = {
      name: 'actualName',
      runtime: 'quickjs' as const,
      code: 'function run() {}',
      version: 1,
      hash: VALID_HASH,
    };

    expect(() => createManifestResponse({ manifestName: definition }, '/unzen'))
      .toThrow('Invalid function definition');
    expect(() => createManifestResponse({
      actualName: { ...definition, hash: 'sha256:invalid' },
    }, '/unzen')).toThrow('Invalid function definition');
  });

  it('rejects an aggregate manifest over the public response limit', () => {
    const definitions: Record<string, {
      name: string;
      runtime: 'quickjs';
      code: string;
      version: number;
      hash: string;
    }> = {};
    for (let index = 0; index < 6_000; index++) {
      const name = `function${index}`;
      definitions[name] = {
        name,
        runtime: 'quickjs',
        code: 'function run() {}',
        version: index + 1,
        hash: VALID_HASH,
      };
    }

    expect(() => createManifestResponse(definitions, '/unzen'))
      .toThrow(`Manifest exceeds ${MAX_MANIFEST_RESPONSE_BYTES} bytes`);
  });
});

describe('createExecutionResponse', () => {
  it('should create success response', () => {
    const response = createExecutionResponse({ success: true, result: 42 });

    expect(response.result).toBe(42);
    expect(response.error).toBeUndefined();
  });

  it('should create error response', () => {
    const response = createExecutionResponse({ success: false, error: 'Test error' });

    expect(response.result).toBeNull();
    expect(response.error).toBe('Test error');
  });
});
