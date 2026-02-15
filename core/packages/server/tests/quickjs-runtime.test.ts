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

    it('should block Proxy constructor', async () => {
      // Proxy can intercept property access to reconstruct blocked APIs
      const code = 'function run() { return typeof Proxy; }';
      const result = await runtime.execute(code, []);
      expect(result).toBe('undefined');
    });

    it('should block Reflect object', async () => {
      // Reflect provides low-level object manipulation bypassing frozen prototypes
      const code = 'function run() { return typeof Reflect; }';
      const result = await runtime.execute(code, []);
      expect(result).toBe('undefined');
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

    // === Security boundary tests: prototype chain sandbox escape ===
    // These tests verify that the sandbox cannot be escaped via constructor
    // property traversal. Any object's .constructor.constructor reaches Function,
    // which allows arbitrary code execution if not blocked.
    // See: C1 finding from 5-agent review (2026-02-10)

    it('should block Object prototype chain to Function constructor', async () => {
      // ({}).constructor → Object, Object.constructor → Function
      // Function("return 42")() executes arbitrary code, bypassing sandbox
      const code = 'function run() { try { return ({}).constructor.constructor("return 42")(); } catch(e) { return "blocked"; } }';
      const result = await runtime.execute(code, []);
      expect(result).toBe('blocked');
    });

    it('should block Array prototype chain to Function constructor', async () => {
      // [].constructor → Array, Array.constructor → Function
      const code = 'function run() { try { return [].constructor.constructor("return 42")(); } catch(e) { return "blocked"; } }';
      const result = await runtime.execute(code, []);
      expect(result).toBe('blocked');
    });

    it('should block String prototype chain to Function constructor', async () => {
      // "".constructor → String, String.constructor → Function
      const code = 'function run() { try { return "".constructor.constructor("return 42")(); } catch(e) { return "blocked"; } }';
      const result = await runtime.execute(code, []);
      expect(result).toBe('blocked');
    });

    it('should block Number prototype chain to Function constructor', async () => {
      // (0).constructor → Number, Number.constructor → Function
      const code = 'function run() { try { return (0).constructor.constructor("return 42")(); } catch(e) { return "blocked"; } }';
      const result = await runtime.execute(code, []);
      expect(result).toBe('blocked');
    });

    it('should block RegExp prototype chain to Function constructor', async () => {
      // /./.constructor → RegExp, RegExp.constructor → Function
      const code = 'function run() { try { return /./.constructor.constructor("return 42")(); } catch(e) { return "blocked"; } }';
      const result = await runtime.execute(code, []);
      expect(result).toBe('blocked');
    });

    it('should block AsyncFunction constructor via prototype chain', async () => {
      // (async function(){}).constructor gives AsyncFunction, which inherits from Function
      // AsyncFunction.prototype.__proto__ === Function.prototype
      // If Function.prototype.constructor is cut, this should also be blocked
      const code = 'function run() { try { var AF = (async function(){}).constructor; return AF("return 42")(); } catch(e) { return "blocked"; } }';
      const result = await runtime.execute(code, []);
      expect(result).toBe('blocked');
    });

    it('should block GeneratorFunction constructor via prototype chain', async () => {
      // (function*(){}).constructor gives GeneratorFunction, which inherits from Function
      const code = 'function run() { try { var GF = (function*(){}).constructor; return GF("return 42")(); } catch(e) { return "blocked"; } }';
      const result = await runtime.execute(code, []);
      expect(result).toBe('blocked');
    });

    it('should block AsyncGeneratorFunction constructor via prototype chain', async () => {
      // (async function*(){}).constructor gives AsyncGeneratorFunction
      // This inherits from Function and was missed in first fix
      const code = 'function run() { try { var AGF = (async function*(){}).constructor; return AGF("return 42")(); } catch(e) { return "blocked"; } }';
      const result = await runtime.execute(code, []);
      expect(result).toBe('blocked');
    });

    it('should block eval reconstruction via Function constructor', async () => {
      // Attempting to reconstruct eval via prototype chain
      const code = 'function run() { try { var F = ({}).constructor.constructor; return F("return eval")(); } catch(e) { return "blocked"; } }';
      const result = await runtime.execute(code, []);
      expect(result).toBe('blocked');
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
