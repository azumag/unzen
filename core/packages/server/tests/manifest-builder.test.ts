/**
 * Tests for ManifestBuilder
 *
 * ManifestBuilder converts FunctionRegistry data into ManifestResponse format
 * using the createManifestResponse helper from @unzen/shared.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ManifestBuilder } from '../src/manifest-builder';
import { FunctionRegistry } from '../src/function-registry';
import type { FunctionDefinition } from '@unzen/shared';

const HASH_A = `sha256:${'a'.repeat(64)}`;
const HASH_B = `sha256:${'b'.repeat(64)}`;

describe('ManifestBuilder', () => {
  let registry: FunctionRegistry;

  beforeEach(() => {
    registry = new FunctionRegistry();
  });

  describe('build', () => {
    it('rejects an invalid base URL during construction', () => {
      expect(() => new ManifestBuilder(registry, 'javascript:alert(1)'))
        .toThrow('baseUrl');
      expect(() => new ManifestBuilder(registry, 'relative/path'))
        .toThrow('baseUrl');
    });

    it('normalizes a root-relative base URL', () => {
      const def: FunctionDefinition = {
        name: 'rootFunction',
        runtime: 'quickjs',
        code: 'return 1',
        version: 1,
        hash: HASH_A,
      };
      registry.register(def);
      const builder = new ManifestBuilder(registry, '  /unzen///  ');

      expect(builder.build().functions.rootFunction.codeUrl).toBe(
        `/unzen/code/rootFunction?v=1&h=${encodeURIComponent(HASH_A)}`,
      );
    });

    it('should build empty manifest from empty registry', () => {
      const builder = new ManifestBuilder(registry, 'https://example.com/unzen');
      const manifest = builder.build();

      expect(manifest.functions).toEqual({});
    });

    it('should build manifest with single function', () => {
      const def: FunctionDefinition = {
        name: 'spamCheck',
        runtime: 'quickjs',
        code: 'return /spam/i.test(args[0])',
        version: 1,
        hash: HASH_A,
      };

      registry.register(def);
      const builder = new ManifestBuilder(registry, 'https://example.com/unzen');
      const manifest = builder.build();

      expect(manifest.functions).toHaveProperty('spamCheck');
      expect(manifest.functions.spamCheck).toEqual({
        runtime: 'quickjs',
        hash: HASH_A,
        version: 1,
        codeUrl: `https://example.com/unzen/code/spamCheck?v=1&h=${encodeURIComponent(HASH_A)}`,
      });
    });

    it('should build manifest with multiple functions', () => {
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
        version: 2,
        hash: HASH_B,
      };

      registry.register(def1);
      registry.register(def2);

      const builder = new ManifestBuilder(registry, 'https://example.com/unzen');
      const manifest = builder.build();

      expect(Object.keys(manifest.functions)).toHaveLength(2);
      expect(manifest.functions.func1.codeUrl).toBe(
        `https://example.com/unzen/code/func1?v=1&h=${encodeURIComponent(HASH_A)}`,
      );
      expect(manifest.functions.func2.codeUrl).toBe(
        `https://example.com/unzen/code/func2?v=2&h=${encodeURIComponent(HASH_B)}`,
      );
    });

    it('should handle baseUrl without trailing slash', () => {
      const def: FunctionDefinition = {
        name: 'testFunc',
        runtime: 'quickjs',
        code: 'return 1',
        version: 1,
        hash: HASH_A,
      };

      registry.register(def);
      const builder = new ManifestBuilder(registry, 'https://example.com/unzen');
      const manifest = builder.build();

      expect(manifest.functions.testFunc.codeUrl).toBe(
        `https://example.com/unzen/code/testFunc?v=1&h=${encodeURIComponent(HASH_A)}`,
      );
    });

    it('should handle baseUrl with trailing slash', () => {
      const def: FunctionDefinition = {
        name: 'testFunc',
        runtime: 'quickjs',
        code: 'return 1',
        version: 1,
        hash: HASH_A,
      };

      registry.register(def);
      const builder = new ManifestBuilder(registry, 'https://example.com/unzen/');
      const manifest = builder.build();

      // Should not have double slashes
      expect(manifest.functions.testFunc.codeUrl).toBe(
        `https://example.com/unzen/code/testFunc?v=1&h=${encodeURIComponent(HASH_A)}`,
      );
    });

    it('should preserve function runtime types', () => {
      const quickjsFunc: FunctionDefinition = {
        name: 'quickjsFunc',
        runtime: 'quickjs',
        code: 'return 1',
        version: 1,
        hash: HASH_A,
      };

      const moonbitFunc: FunctionDefinition = {
        name: 'moonbitFunc',
        runtime: 'moonbit',
        code: 'https://example.com/func.wasm',
        version: 1,
        hash: HASH_B,
      };

      registry.register(quickjsFunc);
      registry.register(moonbitFunc);

      const builder = new ManifestBuilder(registry, 'https://example.com');
      const manifest = builder.build();

      expect(manifest.functions.quickjsFunc.runtime).toBe('quickjs');
      expect(manifest.functions.moonbitFunc.runtime).toBe('moonbit');
    });
  });
});
