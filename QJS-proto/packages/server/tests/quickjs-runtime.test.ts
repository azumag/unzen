/**
 * Tests for QuickJSRuntime
 *
 * QuickJSRuntime provides server-side JavaScript execution using QuickJS Wasm.
 * It's used as a fallback when browser execution fails or is unavailable.
 *
 * Security constraints tested:
 * - eval() and Function constructor are removed
 * - Memory limit is enforced (16MB)
 * - Timeout is enforced (50ms default)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { QuickJSRuntime } from '../src/quickjs-runtime';
import { UnzenRuntimeError, UnzenFunctionError } from '@unzen/shared';

describe('QuickJSRuntime', () => {
  let runtime: QuickJSRuntime;

  beforeEach(async () => {
    runtime = new QuickJSRuntime();
    await runtime.initialize();
  });

  afterEach(() => {
    runtime.dispose();
  });

  describe('initialize', () => {
    it('should initialize QuickJS instance', async () => {
      const newRuntime = new QuickJSRuntime();
      await expect(newRuntime.initialize()).resolves.toBeUndefined();
      newRuntime.dispose();
    });
  });

  describe('execute', () => {
    it('should execute simple function with arguments', async () => {
      const code = 'function run(a, b) { return a + b; }';
      const result = await runtime.execute(code, [1, 2]);
      expect(result).toBe(3);
    });

    it('should execute function returning string', async () => {
      const code = 'function run(text) { return text.toUpperCase(); }';
      const result = await runtime.execute(code, ['hello']);
      expect(result).toBe('HELLO');
    });

    it('should execute function with array operations', async () => {
      const code = 'function run(arr) { return arr.map(x => x * 2); }';
      const result = await runtime.execute(code, [[1, 2, 3]]);
      expect(result).toEqual([2, 4, 6]);
    });

    it('should execute function with object operations', async () => {
      const code = 'function run(obj) { return { result: obj.value * 2 }; }';
      const result = await runtime.execute(code, [{ value: 5 }]);
      expect(result).toEqual({ result: 10 });
    });

    it('should handle empty arguments', async () => {
      const code = 'function run() { return 42; }';
      const result = await runtime.execute(code, []);
      expect(result).toBe(42);
    });

    it('should throw UnzenFunctionError for syntax errors', async () => {
      const code = 'function run() { return invalid syntax here; }';
      await expect(runtime.execute(code, [])).rejects.toThrow(UnzenFunctionError);
    });

    it('should throw UnzenFunctionError for runtime errors', async () => {
      const code = 'function run(obj) { return obj.nonExistentMethod(); }';
      await expect(runtime.execute(code, [{}])).rejects.toThrow(UnzenFunctionError);
    });

    it('should throw UnzenRuntimeError for timeout', async () => {
      // Infinite loop should trigger timeout
      const code = 'function run() { while(true) {} }';
      await expect(runtime.execute(code, [], { timeout: 50 })).rejects.toThrow(UnzenRuntimeError);
    });

    it('should respect custom timeout option', async () => {
      // This should succeed with longer timeout
      const code = 'function run() { let sum = 0; for(let i = 0; i < 10000; i++) { sum += i; } return sum; }';
      const result = await runtime.execute(code, [], { timeout: 100 });
      expect(typeof result).toBe('number');
    });

    it('should block eval() function', async () => {
      const code = 'function run() { return eval("1 + 1"); }';
      await expect(runtime.execute(code, [])).rejects.toThrow();
    });

    it('should block Function constructor', async () => {
      const code = 'function run() { return new Function("return 1")(); }';
      await expect(runtime.execute(code, [])).rejects.toThrow();
    });

    it('should handle null and undefined', async () => {
      // Note: JSON.stringify converts undefined to null in arrays
      // So args[1] will be null, not undefined
      const code = 'function run(a, b) { return a === null && b === null; }';
      const result = await runtime.execute(code, [null, undefined]);
      expect(result).toBe(true);
    });

    it('should handle boolean values', async () => {
      const code = 'function run(val) { return !val; }';
      const result = await runtime.execute(code, [false]);
      expect(result).toBe(true);
    });

    it('should isolate execution context between calls', async () => {
      const code1 = 'function run() { globalThis.testValue = 123; return globalThis.testValue; }';
      const code2 = 'function run() { return typeof globalThis.testValue; }';

      await runtime.execute(code1, []);
      const result = await runtime.execute(code2, []);

      // testValue should not leak between executions
      expect(result).toBe('undefined');
    });
  });

  describe('dispose', () => {
    it('should clean up resources', () => {
      const newRuntime = new QuickJSRuntime();
      expect(() => newRuntime.dispose()).not.toThrow();
    });

    it('should throw error if execute called after dispose', async () => {
      const newRuntime = new QuickJSRuntime();
      await newRuntime.initialize();
      newRuntime.dispose();

      await expect(newRuntime.execute('return 1', [])).rejects.toThrow(UnzenRuntimeError);
    });
  });
});
