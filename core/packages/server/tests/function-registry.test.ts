/**
 * Tests for FunctionRegistry
 *
 * FunctionRegistry manages the internal storage of function definitions.
 * It provides basic CRUD operations for function management.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FunctionRegistry } from '../src/function-registry';
import type { FunctionDefinition } from '@unzen/shared';

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
        hash: 'sha256:abc123',
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
        hash: 'sha256:abc123',
      };

      const def2: FunctionDefinition = {
        name: 'testFunc',
        runtime: 'quickjs',
        code: 'return args[0] + 2',
        version: 2,
        hash: 'sha256:def456',
      };

      registry.register(def1);
      registry.register(def2);

      const result = registry.get('testFunc');
      expect(result?.version).toBe(2);
      expect(result?.hash).toBe('sha256:def456');
    });

    it('should handle multiple functions', () => {
      const def1: FunctionDefinition = {
        name: 'func1',
        runtime: 'quickjs',
        code: 'return 1',
        version: 1,
        hash: 'sha256:a',
      };

      const def2: FunctionDefinition = {
        name: 'func2',
        runtime: 'moonbit',
        code: 'https://example.com/func2.wasm',
        version: 1,
        hash: 'sha256:b',
      };

      registry.register(def1);
      registry.register(def2);

      expect(registry.has('func1')).toBe(true);
      expect(registry.has('func2')).toBe(true);
    });
  });

  describe('get', () => {
    it('should return function definition by name', () => {
      const def: FunctionDefinition = {
        name: 'testFunc',
        runtime: 'quickjs',
        code: 'return args[0] + 1',
        version: 1,
        hash: 'sha256:abc123',
      };

      registry.register(def);
      const result = registry.get('testFunc');

      expect(result).toEqual(def);
    });

    it('should return undefined for non-existent function', () => {
      const result = registry.get('nonExistent');
      expect(result).toBeUndefined();
    });
  });

  describe('has', () => {
    it('should return true for registered function', () => {
      const def: FunctionDefinition = {
        name: 'testFunc',
        runtime: 'quickjs',
        code: 'return 1',
        version: 1,
        hash: 'sha256:abc',
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
        hash: 'sha256:a',
      };

      const def2: FunctionDefinition = {
        name: 'func2',
        runtime: 'quickjs',
        code: 'return 2',
        version: 1,
        hash: 'sha256:b',
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
        hash: 'sha256:abc',
      };

      registry.register(def);
      const all1 = registry.getAll();
      all1.delete('testFunc');

      // Original registry should not be affected
      expect(registry.has('testFunc')).toBe(true);
    });
  });
});
