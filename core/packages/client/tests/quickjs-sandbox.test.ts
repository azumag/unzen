/**
 * Tests for QuickJS Sandbox
 *
 * QuickJSSandbox provides an interface for executing JavaScript code
 * in a sandboxed environment. For MVP, we use a mock implementation
 * that executes code in the same process (Node.js eval).
 *
 * Real implementation (Phase 2+) will use:
 * - Web Worker for isolation
 * - QuickJS Wasm for sandboxing
 * - Message passing for communication
 *
 * Test strategy:
 * - Test MockSandboxExecutor (the only implementation for MVP)
 * - Test successful execution
 * - Test function errors
 * - Test disposal
 */

import { describe, it, expect } from 'vitest';
import { MAX_EXECUTION_ARGUMENTS, UnzenFunctionError } from '@unzen/shared';
import { MockSandboxExecutor } from '../src/quickjs-sandbox';

describe('MockSandboxExecutor', () => {
  it('should create instance', () => {
    const executor = new MockSandboxExecutor();
    expect(executor).toBeDefined();
  });

  it('should execute simple code successfully', async () => {
    const executor = new MockSandboxExecutor();
    const code = 'function run(a, b) { return a + b; }';
    const result = await executor.execute(code, [1, 2]);

    expect(result).toBe(3);
    executor.dispose();
  });

  it('should execute code with no arguments', async () => {
    const executor = new MockSandboxExecutor();
    const code = 'function run() { return 42; }';
    const result = await executor.execute(code, []);

    expect(result).toBe(42);
    executor.dispose();
  });

  it('should enforce the JSON call boundary without invoking the args iterator', async () => {
    const executor = new MockSandboxExecutor();
    const args = [1, 2];
    Object.defineProperty(args, Symbol.iterator, {
      value: () => {
        throw new Error('argument iterator must not run at the executor boundary');
      },
    });

    await expect(executor.execute('function run(a, b) { return a + b; }', args))
      .resolves.toBe(3);

    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    await expect(executor.execute('function run() { return 1; }', cyclic))
      .rejects.toThrow(UnzenFunctionError);
    await expect(executor.execute(
      'function run() { return 1; }',
      new Array(MAX_EXECUTION_ARGUMENTS + 1),
    )).rejects.toThrow(UnzenFunctionError);
    executor.dispose();
  });

  it('should execute code returning object', async () => {
    const executor = new MockSandboxExecutor();
    const code = 'function run(name) { return { greeting: "Hello, " + name }; }';
    const result = await executor.execute(code, ['World']);

    expect(result).toEqual({ greeting: 'Hello, World' });
    executor.dispose();
  });

  it('should execute code returning array', async () => {
    const executor = new MockSandboxExecutor();
    const code = 'function run(n) { return Array.from({ length: n }, (_, i) => i); }';
    const result = await executor.execute(code, [3]);

    expect(result).toEqual([0, 1, 2]);
    executor.dispose();
  });

  it.each([
    ['an async function', 'async function run() { return 42; }', 'return synchronously'],
    ['a Promise', 'function run() { return Promise.resolve(42); }', 'return synchronously'],
    [
      'a generator',
      'function run() { return (function* () { yield 42; })(); }',
      'materialized value',
    ],
  ])('should reject %s result', async (_label, code, message) => {
    const executor = new MockSandboxExecutor();

    await expect(executor.execute(code, [])).rejects.toThrow(UnzenFunctionError);
    await expect(executor.execute(code, [])).rejects.toThrow(message);
    executor.dispose();
  });

  it('should throw UnzenFunctionError on execution error', async () => {
    const executor = new MockSandboxExecutor();
    const code = 'function run() { throw new Error("Test error"); }';

    await expect(executor.execute(code, [])).rejects.toThrow(
      UnzenFunctionError
    );
    await expect(executor.execute(code, [])).rejects.toThrow('Test error');

    executor.dispose();
  });

  it('should throw UnzenFunctionError on reference error', async () => {
    const executor = new MockSandboxExecutor();
    const code = 'function run() { return nonexistent; }';

    await expect(executor.execute(code, [])).rejects.toThrow(
      UnzenFunctionError
    );

    executor.dispose();
  });

  it('should throw UnzenFunctionError if function is not defined', async () => {
    const executor = new MockSandboxExecutor();
    const code = 'const x = 1;'; // No 'run' function

    await expect(executor.execute(code, [])).rejects.toThrow(
      UnzenFunctionError
    );

    executor.dispose();
  });

  it('should handle multiple executions', async () => {
    const executor = new MockSandboxExecutor();
    const code1 = 'function run(x) { return x * 2; }';
    const code2 = 'function run(x) { return x * 3; }';

    const result1 = await executor.execute(code1, [5]);
    expect(result1).toBe(10);

    const result2 = await executor.execute(code2, [5]);
    expect(result2).toBe(15);

    executor.dispose();
  });

  it('should handle disposal gracefully', () => {
    const executor = new MockSandboxExecutor();
    expect(() => executor.dispose()).not.toThrow();
    expect(() => executor.dispose()).not.toThrow(); // Second disposal should also be safe
  });

  // === SandboxExecutor Contract Tests (H1 finding from 5-agent review) ===
  // These tests document the security behavior expected from ANY SandboxExecutor
  // implementation. MockSandboxExecutor is NOT secure (uses Node.js vm), but
  // these tests document the contract for Phase 2's real QuickJS Wasm executor.
  //
  // Contract: SandboxExecutor must handle all execution failures as UnzenFunctionError
  // Contract: SandboxExecutor must require 'run' function in code
  // Contract: SandboxExecutor must isolate execution contexts

  describe('SandboxExecutor contract', () => {
    it('contract: must throw UnzenFunctionError for missing run function', async () => {
      const executor = new MockSandboxExecutor();
      // Any SandboxExecutor implementation must throw UnzenFunctionError
      // when the code doesn't define a 'run' function
      await expect(executor.execute('var x = 1;', [])).rejects.toThrow(UnzenFunctionError);
      executor.dispose();
    });

    it('contract: must throw UnzenFunctionError for code throwing errors', async () => {
      const executor = new MockSandboxExecutor();
      const code = 'function run() { throw new Error("user error"); }';
      await expect(executor.execute(code, [])).rejects.toThrow(UnzenFunctionError);
      executor.dispose();
    });

    it('contract: must pass arguments correctly to run function', async () => {
      const executor = new MockSandboxExecutor();
      const code = 'function run(a, b, c) { return [a, b, c]; }';
      const result = await executor.execute(code, [1, 'two', true]);
      expect(result).toEqual([1, 'two', true]);
      executor.dispose();
    });

    it('contract: must support object arguments and return values', async () => {
      const executor = new MockSandboxExecutor();
      const code = 'function run(obj) { return { doubled: obj.value * 2 }; }';
      const result = await executor.execute(code, [{ value: 21 }]);
      expect(result).toEqual({ doubled: 42 });
      executor.dispose();
    });

    it('contract: dispose must be idempotent (safe to call multiple times)', () => {
      const executor = new MockSandboxExecutor();
      expect(() => {
        executor.dispose();
        executor.dispose();
        executor.dispose();
      }).not.toThrow();
    });
  });

  it('should isolate execution context between calls', async () => {
    const executor = new MockSandboxExecutor();

    // First execution sets a "global" variable
    const code1 = 'function run() { globalThis.testVar = 42; return testVar; }';
    await executor.execute(code1, []);

    // Second execution should not see testVar from first execution
    // (because each execute() creates fresh context)
    const code2 = 'function run() { return typeof globalThis.testVar; }';
    const result = await executor.execute(code2, []);

    // Should be 'undefined' if properly isolated
    // Note: MockSandboxExecutor may not fully isolate in Node.js
    // This test documents expected behavior for real implementation
    expect(result).toBe('undefined');

    executor.dispose();
  });
});
