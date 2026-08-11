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
  createManifestResponse,
  createExecutionResponse,
} from '../src/protocol';
import { RuntimeType } from '../src/types';

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
});

describe('createManifestResponse', () => {
  it('should create response from function definitions', () => {
    const functions = {
      spamCheck: {
        name: 'spamCheck',
        runtime: 'quickjs' as RuntimeType,
        code: 'return /spam/i.test(args[0])',
        version: 1,
        hash: 'sha256:abc123',
      },
    };

    const response = createManifestResponse(functions, 'https://example.com/unzen');

    expect(response.functions.spamCheck.runtime).toBe('quickjs');
    expect(response.functions.spamCheck.hash).toBe('sha256:abc123');
    expect(response.functions.spamCheck.version).toBe(1);
    expect(response.functions.spamCheck.codeUrl).toBe(
      'https://example.com/unzen/code/spamCheck?v=1&h=sha256%3Aabc123',
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
      hash: 'sha256:first',
    };
    const first = createManifestResponse({ calculate: definition }, '/unzen');
    const second = createManifestResponse({
      calculate: { ...definition, hash: 'sha256:second' },
    }, '/unzen');

    expect(first.functions.calculate.codeUrl).not.toBe(second.functions.calculate.codeUrl);
    expect(first.functions.calculate.codeUrl).toContain('v=1&h=sha256%3Afirst');
    expect(second.functions.calculate.codeUrl).toContain('v=1&h=sha256%3Asecond');
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
        hash: 'sha256:abc123',
        moonbitAbi: sourceAbi,
      },
    }, 'https://example.com/unzen');

    expect(response.functions.scale.moonbitAbi).toEqual(abi);
    expect(response.functions.scale.moonbitAbi).not.toBe(sourceAbi);
    expect(response.functions.scale.moonbitAbi?.params).not.toBe(sourceParams);
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
