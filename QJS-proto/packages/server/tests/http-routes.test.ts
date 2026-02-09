/**
 * Tests for HTTP Routes (Hono middleware)
 *
 * Tests the three HTTP endpoints:
 * - GET /manifest: Returns function manifest
 * - GET /code/:name: Returns function code
 * - POST /exec/:name: Executes function server-side
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { UnzenServer } from '../src/unzen-server';

describe('HTTP Routes', () => {
  let app: Hono;
  let server: UnzenServer;

  beforeEach(async () => {
    app = new Hono();
    server = new UnzenServer({ baseUrl: 'https://example.com/unzen' });
    await server.initialize();
    app.route('/unzen', server.middleware());
  });

  describe('GET /manifest', () => {
    it('should return empty manifest for new server', async () => {
      const res = await app.request('/unzen/manifest');

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.functions).toEqual({});
    });

    it('should return manifest with registered functions', async () => {
      server.define('func1', () => 1);
      server.define('func2', () => 2);

      const res = await app.request('/unzen/manifest');

      expect(res.status).toBe(200);
      const data = await res.json();

      expect(Object.keys(data.functions)).toHaveLength(2);
      expect(data.functions.func1).toBeDefined();
      expect(data.functions.func2).toBeDefined();

      expect(data.functions.func1.runtime).toBe('quickjs');
      expect(data.functions.func1.codeUrl).toBe('https://example.com/unzen/code/func1?v=1');
      expect(data.functions.func2.codeUrl).toBe('https://example.com/unzen/code/func2?v=2');
    });

    it('should return correct content-type header', async () => {
      const res = await app.request('/unzen/manifest');

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/json');
    });
  });

  describe('GET /code/:name', () => {
    it('should return function code', async () => {
      const testFunc = function (text: string) {
        return text.toUpperCase();
      };
      server.define('uppercase', testFunc);

      const res = await app.request('/unzen/code/uppercase');

      expect(res.status).toBe(200);
      const code = await res.text();
      expect(code).toContain('toUpperCase');
    });

    it('should return 404 for non-existent function', async () => {
      const res = await app.request('/unzen/code/nonExistent');
      expect(res.status).toBe(404);
    });

    it('should return correct content-type header', async () => {
      server.define('test', () => 1);
      const res = await app.request('/unzen/code/test');

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/javascript');
    });

    it('should set cache headers for immutable code', async () => {
      server.define('test', () => 1);
      const res = await app.request('/unzen/code/test?v=1');

      expect(res.status).toBe(200);
      // Immutable content should have long cache duration
      expect(res.headers.get('cache-control')).toContain('immutable');
    });
  });

  describe('POST /exec/:name', () => {
    it('should execute function with arguments', async () => {
      server.defineRaw('double', '(x) => x * 2');

      const res = await app.request('/unzen/exec/double', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ args: [5] }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.result).toBe(10);
      expect(data.error).toBeUndefined();
    });

    it('should return error for non-existent function', async () => {
      const res = await app.request('/unzen/exec/nonExistent', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ args: [] }),
      });

      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error).toBeDefined();
    });

    it('should return 400 for function execution errors (user code bugs)', async () => {
      server.defineRaw('errorFunc', '() => { throw new Error("test error"); }');

      const res = await app.request('/unzen/exec/errorFunc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ args: [] }),
      });

      expect(res.status).toBe(400); // UnzenFunctionError → HTTP 400
      const data = await res.json();
      expect(data.error).toBeDefined();
      expect(data.result).toBeNull();
    });

    it('should return 400 for syntax errors', async () => {
      server.defineRaw('syntaxError', 'invalid syntax here');

      const res = await app.request('/unzen/exec/syntaxError', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ args: [] }),
      });

      expect(res.status).toBe(400); // UnzenFunctionError → HTTP 400
      const data = await res.json();
      expect(data.error).toBeDefined();
    });

    it('should execute function with multiple arguments', async () => {
      server.defineRaw('sum', '(a, b, c) => a + b + c');

      const res = await app.request('/unzen/exec/sum', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ args: [1, 2, 3] }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.result).toBe(6);
    });

    it('should execute function with complex arguments', async () => {
      server.defineRaw('getField', '(obj) => obj.field');

      const res = await app.request('/unzen/exec/getField', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ args: [{ field: 'value' }] }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.result).toBe('value');
    });

    // === Input validation tests (H2 finding from 5-agent review) ===
    // POST /exec/:name must validate request body to prevent DoS and errors

    it('should return 400 for missing args field', async () => {
      server.defineRaw('test', '() => 1');

      const res = await app.request('/unzen/exec/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBeDefined();
    });

    it('should return 400 for non-array args', async () => {
      server.defineRaw('test', '() => 1');

      const res = await app.request('/unzen/exec/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ args: 'not-an-array' }),
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBeDefined();
    });

    it('should return 400 for args with too many elements', async () => {
      server.defineRaw('test', '() => 1');

      // 128+ args is excessive and likely malicious
      const res = await app.request('/unzen/exec/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ args: Array(129).fill(0) }),
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBeDefined();
    });

    it('should return 400 for invalid JSON body', async () => {
      server.defineRaw('test', '() => 1');

      const res = await app.request('/unzen/exec/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not-json',
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBeDefined();
    });

    // === Error message sanitization tests (H3 finding) ===
    // Error responses must not leak internal server details

    it('should not leak internal file paths in error messages', async () => {
      server.defineRaw('errorFunc', '() => { throw new Error("test error"); }');

      const res = await app.request('/unzen/exec/errorFunc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ args: [] }),
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      // Error message should not contain file system paths
      expect(data.error).not.toMatch(/\/(Users|home|var|tmp)\//);
      // Error message should not contain stack traces
      expect(data.error).not.toContain('at ');
    });

    it('should return generic message for runtime errors', async () => {
      server.defineRaw('timeout', '() => { while(true) {} }');

      const res = await app.request('/unzen/exec/timeout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ args: [] }),
      });

      expect(res.status).toBe(500);
      const data = await res.json();
      // Should not expose internal timeout configuration details
      expect(data.error).toBeDefined();
      expect(typeof data.error).toBe('string');
    });
  });
});
