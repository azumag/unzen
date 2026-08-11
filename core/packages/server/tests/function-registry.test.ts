/**
 * Tests for FunctionRegistry
 *
 * FunctionRegistry manages the internal storage of function definitions.
 * It provides basic CRUD operations for function management.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FunctionRegistry } from '../src/function-registry';
import type { FunctionDefinition } from '@unzen/shared';

const HASH_A = `sha256:${'a'.repeat(64)}`;
const HASH_B = `sha256:${'b'.repeat(64)}`;

describe('FunctionRegistry', () => {
  let registry: FunctionRegistry;

  beforeEach(() => {
    registry = new FunctionRegistry();
  });

  describe('register', () => {
    it('should register a new function definition', () => {
      const def: FunctionDefinition = {
        name: 'testFunc',
        runtime: 'quickjs',
        code: 'return args[0] + 1',
        version: 1,
        hash: HASH_A,
      };

      registry.register(def);
      expect(registry.has('testFunc')).toBe(true);
    });

    it('should overwrite existing function with same name', () => {
      const def1: FunctionDefinition = {
        name: 'testFunc',
        runtime: 'quickjs',
        code: 'return args[0] + 1',
        version: 1,
        hash: HASH_A,
      };

      const def2: FunctionDefinition = {
        name: 'testFunc',
        runtime: 'quickjs',
        code: 'return args[0] + 2',
        version: 2,
        hash: HASH_B,
      };

      registry.register(def1);
      registry.register(def2);

      const result = registry.get('testFunc');
      expect(result?.version).toBe(2);
      expect(result?.hash).toBe(HASH_B);
    });

    it('should handle multiple functions', () => {
      const def1: FunctionDefinition = {
        name: 'func1',
        runtime: 'quickjs',
        code: 'return 1',
        version: 1,
        hash: HASH_A,
      };

      const def2: FunctionDefinition = {
        name: 'func2',
        runtime: 'moonbit',
        code: 'https://example.com/func2.wasm',
        version: 1,
        hash: HASH_B,
      };

      registry.register(def1);
      registry.register(def2);

      expect(registry.has('func1')).toBe(true);
      expect(registry.has('func2')).toBe(true);
    });

    it('snapshots definitions and nested MoonBit ABI metadata', () => {
      const def: FunctionDefinition = {
        name: 'sumArray',
        runtime: 'moonbit',
        code: 'sum.wasm',
        version: 1,
        hash: HASH_A,
        exportName: 'sum_array',
        moonbitAbi: { params: ['i32[]'], result: 'scalar' },
        noFallback: true,
      };
      registry.register(def);

      def.code = 'tampered.wasm';
      def.hash = `sha256:${'f'.repeat(64)}`;
      def.moonbitAbi!.params[0] = 'f64[]';

      expect(registry.get('sumArray')).toMatchObject({
        code: 'sum.wasm',
        hash: HASH_A,
        moonbitAbi: { params: ['i32[]'], result: 'scalar' },
      });
    });

    it('rejects invalid definitions', () => {
      expect(() => registry.register({
        name: '../escape',
        runtime: 'quickjs',
        code: 'function run() {}',
        version: 1,
        hash: HASH_A,
      })).toThrow('Invalid function definition');
    });
  });

  describe('get', () => {
    it('should return function definition by name', () => {
      const def: FunctionDefinition = {
        name: 'testFunc',
        runtime: 'quickjs',
        code: 'return args[0] + 1',
        version: 1,
        hash: HASH_A,
      };

      registry.register(def);
      const result = registry.get('testFunc');

      expect(result).toEqual(def);
    });

    it('should return undefined for non-existent function', () => {
      const result = registry.get('nonExistent');
      expect(result).toBeUndefined();
    });

    it('returns an isolated copy on every read', () => {
      const def: FunctionDefinition = {
        name: 'testFunc',
        runtime: 'quickjs',
        code: 'function run() { return 1; }',
        version: 1,
        hash: HASH_A,
      };
      registry.register(def);

      const first = registry.get('testFunc')!;
      first.code = 'function run() { return 999; }';
      const second = registry.get('testFunc')!;

      expect(second.code).toBe('function run() { return 1; }');
      expect(second).not.toBe(first);
    });
  });

  describe('has', () => {
    it('should return true for registered function', () => {
      const def: FunctionDefinition = {
        name: 'testFunc',
        runtime: 'quickjs',
        code: 'return 1',
        version: 1,
        hash: HASH_A,
      };

      registry.register(def);
      expect(registry.has('testFunc')).toBe(true);
    });

    it('should return false for non-existent function', () => {
      expect(registry.has('nonExistent')).toBe(false);
    });
  });

  describe('getAll', () => {
    it('should return empty map for new registry', () => {
      const all = registry.getAll();
      expect(all.size).toBe(0);
    });

    it('should return all registered functions', () => {
      const def1: FunctionDefinition = {
        name: 'func1',
        runtime: 'quickjs',
        code: 'return 1',
        version: 1,
        hash: HASH_A,
      };

      const def2: FunctionDefinition = {
        name: 'func2',
        runtime: 'quickjs',
        code: 'return 2',
        version: 1,
        hash: HASH_B,
      };

      registry.register(def1);
      registry.register(def2);

      const all = registry.getAll();
      expect(all.size).toBe(2);
      expect(all.get('func1')).toEqual(def1);
      expect(all.get('func2')).toEqual(def2);
    });

    it('should return a copy of the internal map to prevent external modification', () => {
      const def: FunctionDefinition = {
        name: 'testFunc',
        runtime: 'quickjs',
        code: 'return 1',
        version: 1,
        hash: HASH_A,
      };

      registry.register(def);
      const all1 = registry.getAll();
      all1.delete('testFunc');

      // Original registry should not be affected
      expect(registry.has('testFunc')).toBe(true);
    });

    it('returns isolated definition values in the copied map', () => {
      const def: FunctionDefinition = {
        name: 'testFunc',
        runtime: 'quickjs',
        code: 'function run() { return 1; }',
        version: 1,
        hash: HASH_A,
      };
      registry.register(def);

      registry.getAll().get('testFunc')!.code = 'tampered';
      expect(registry.getAll().get('testFunc')?.code)
        .toBe('function run() { return 1; }');
    });
  });
});
