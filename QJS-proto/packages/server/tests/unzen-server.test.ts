/**
 * Tests for UnzenServer
 *
 * UnzenServer is the main server class that ties together all components:
 * - FunctionRegistry for storage
 * - ManifestBuilder for manifest generation
 * - QuickJSRuntime for fallback execution
 * - Hono middleware for HTTP endpoints
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { UnzenServer } from '../src/unzen-server';
import type { FunctionDefinition } from '@unzen/shared';

describe('UnzenServer', () => {
  let server: UnzenServer;

  beforeEach(async () => {
    server = new UnzenServer({ baseUrl: 'https://example.com/unzen' });
    await server.initialize();
  });

  describe('define', () => {
    it('should register a JavaScript function', () => {
      const testFunc = function (text: string) {
        return text.toUpperCase();
      };

      server.define('uppercase', testFunc);

      const fn = server.getFunction('uppercase');
      expect(fn).toBeDefined();
      expect(fn?.name).toBe('uppercase');
      expect(fn?.runtime).toBe('quickjs');
      expect(fn?.code).toContain('toUpperCase');
    });

    it('should wrap function code with run() function', () => {
      const testFunc = function (x: number) {
        return x * 2;
      };

      server.define('double', testFunc);

      const fn = server.getFunction('double');
      expect(fn?.code).toContain('function run');
      expect(fn?.code).toMatch(/function run\s*\(/);
    });

    it('should generate unique hash for function code', () => {
      const func1 = function () {
        return 1;
      };
      const func2 = function () {
        return 2;
      };

      server.define('func1', func1);
      server.define('func2', func2);

      const fn1 = server.getFunction('func1');
      const fn2 = server.getFunction('func2');

      expect(fn1?.hash).not.toBe(fn2?.hash);
    });

    it('should increment version for each registration', () => {
      const func1 = function () {
        return 1;
      };
      const func2 = function () {
        return 2;
      };

      server.define('func1', func1);
      server.define('func2', func2);

      const fn1 = server.getFunction('func1');
      const fn2 = server.getFunction('func2');

      expect(fn1?.version).toBe(1);
      expect(fn2?.version).toBe(2);
    });

    it('should update version when re-registering function', () => {
      const func1 = function () {
        return 1;
      };
      const func2 = function () {
        return 2;
      };

      server.define('testFunc', func1);
      const v1 = server.getFunction('testFunc')?.version;

      server.define('testFunc', func2);
      const v2 = server.getFunction('testFunc')?.version;

      expect(v2).toBeGreaterThan(v1!);
    });
  });

  describe('defineRaw', () => {
    it('should register function from raw code string', () => {
      const code = '(x) => x * 2';

      server.defineRaw('double', code);

      const fn = server.getFunction('double');
      expect(fn).toBeDefined();
      expect(fn?.code).toContain('function run');
      expect(fn?.runtime).toBe('quickjs');
    });

    it('should wrap raw code with run() function', () => {
      const code = '(x) => x * 2';

      server.defineRaw('double', code);

      const fn = server.getFunction('double');
      expect(fn?.code).toContain('function run');
      expect(fn?.code).toContain(code);
    });

    it('should generate hash from code string', () => {
      const code1 = 'return args[0] + 1';
      const code2 = 'return args[0] + 2';

      server.defineRaw('func1', code1);
      server.defineRaw('func2', code2);

      const fn1 = server.getFunction('func1');
      const fn2 = server.getFunction('func2');

      expect(fn1?.hash).not.toBe(fn2?.hash);
    });
  });

  describe('getFunction', () => {
    it('should return function definition by name', () => {
      const testFunc = function () {
        return 42;
      };

      server.define('testFunc', testFunc);
      const fn = server.getFunction('testFunc');

      expect(fn).toBeDefined();
      expect(fn?.name).toBe('testFunc');
    });

    it('should return undefined for non-existent function', () => {
      const fn = server.getFunction('nonExistent');
      expect(fn).toBeUndefined();
    });
  });

  describe('configuration', () => {
    it('should accept baseUrl in constructor', async () => {
      const server1 = new UnzenServer({ baseUrl: 'https://example.com' });
      const server2 = new UnzenServer({ baseUrl: 'https://test.com' });

      await server1.initialize();
      await server2.initialize();

      server1.define('func', () => 1);
      server2.define('func', () => 1);

      // baseUrl will be tested via middleware in integration tests
      expect(server1.getFunction('func')).toBeDefined();
      expect(server2.getFunction('func')).toBeDefined();
    });

    it('should have default configuration', async () => {
      const defaultServer = new UnzenServer();
      await defaultServer.initialize();

      expect(defaultServer).toBeDefined();

      defaultServer.define('test', () => 1);
      expect(defaultServer.getFunction('test')).toBeDefined();
    });
  });

  describe('initialize', () => {
    it('should initialize QuickJS runtime', async () => {
      const newServer = new UnzenServer();
      await expect(newServer.initialize()).resolves.toBeUndefined();
    });
  });
});
