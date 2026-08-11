/**
 * Integration Tests for E2E Demo
 *
 * Tests the full flow:
 * 1. Server startup
 * 2. Manifest retrieval
 * 3. Function code retrieval
 * 4. Fallback execution
 *
 * Uses Hono's testClient (app.request) for HTTP-level testing
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { app } from '../server';

describe('E2E Integration Tests', () => {
  describe('Manifest Endpoint', () => {
    it('should return manifest with registered functions', async () => {
      const res = await app.request('/unzen/manifest');

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/json');

      const data = await res.json();
      expect(data.functions).toBeDefined();
      expect(data.functions.spamCheck).toBeDefined();
      expect(data.functions.add).toBeDefined();
    });

    it('should include correct metadata for spamCheck', async () => {
      const res = await app.request('/unzen/manifest');
      const data = await res.json();

      const spamCheck = data.functions.spamCheck;
      expect(spamCheck.runtime).toBe('quickjs');
      expect(spamCheck.hash).toMatch(/^sha256:/);
      expect(spamCheck.version).toBeGreaterThan(0);
      expect(spamCheck.codeUrl).toContain('/unzen/code/spamCheck');
    });

    it('should include correct metadata for add', async () => {
      const res = await app.request('/unzen/manifest');
      const data = await res.json();

      const add = data.functions.add;
      expect(add.runtime).toBe('quickjs');
      expect(add.hash).toMatch(/^sha256:/);
      expect(add.version).toBeGreaterThan(0);
      expect(add.codeUrl).toContain('/unzen/code/add');
    });
  });

  describe('Code Endpoint', () => {
    it('should return spamCheck function code', async () => {
      const res = await app.request('/unzen/code/spamCheck');

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/javascript');

      const code = await res.text();
      expect(code).toContain('function run');
      expect(code).toContain('spamKeywords');
    });

    it('should return add function code', async () => {
      const res = await app.request('/unzen/code/add');

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/javascript');

      const code = await res.text();
      expect(code).toContain('function run');
      expect(code).toContain('a + b');
    });

    it('should return 404 for non-existent function', async () => {
      const res = await app.request('/unzen/code/nonExistent');

      expect(res.status).toBe(404);
    });

    it('should set cache headers for immutable code', async () => {
      const manifest = await (await app.request('/unzen/manifest')).json();
      const res = await app.request(manifest.functions.spamCheck.codeUrl);

      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toContain('immutable');
    });
  });

  describe('Fallback Execution - spamCheck', () => {
    it('should detect spam text (positive case)', async () => {
      const res = await app.request('/unzen/exec/spamCheck', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ args: ['Buy now and get free money!'] }),
      });

      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.result).toBe(true);
      expect(data.error).toBeUndefined();
    });

    it('should not detect spam in clean text (negative case)', async () => {
      const res = await app.request('/unzen/exec/spamCheck', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ args: ['Hello, how are you?'] }),
      });

      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.result).toBe(false);
      expect(data.error).toBeUndefined();
    });

    it('should detect "spam" keyword', async () => {
      const res = await app.request('/unzen/exec/spamCheck', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ args: ['This is spam'] }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.result).toBe(true);
    });

    it('should detect "click here" keyword', async () => {
      const res = await app.request('/unzen/exec/spamCheck', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ args: ['Click here for more!'] }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.result).toBe(true);
    });

    it('should be case-insensitive', async () => {
      const res = await app.request('/unzen/exec/spamCheck', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ args: ['BUY NOW!!!'] }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.result).toBe(true);
    });
  });

  describe('Fallback Execution - add', () => {
    it('should add two positive numbers', async () => {
      const res = await app.request('/unzen/exec/add', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ args: [1, 2] }),
      });

      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.result).toBe(3);
      expect(data.error).toBeUndefined();
    });

    it('should add negative numbers', async () => {
      const res = await app.request('/unzen/exec/add', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ args: [-5, -3] }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.result).toBe(-8);
    });

    it('should add zero', async () => {
      const res = await app.request('/unzen/exec/add', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ args: [0, 0] }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.result).toBe(0);
    });

    it('should add decimal numbers', async () => {
      const res = await app.request('/unzen/exec/add', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ args: [1.5, 2.3] }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.result).toBeCloseTo(3.8, 1);
    });
  });

  describe('Error Handling', () => {
    it('should return 404 for non-existent function', async () => {
      const res = await app.request('/unzen/exec/nonExistent', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ args: [] }),
      });

      expect(res.status).toBe(404);

      const data = await res.json();
      expect(data.error).toBeDefined();
      expect(data.result).toBeNull();
    });

    it('should return 400 for function execution errors', async () => {
      // spamCheckを間違った引数で呼ぶ（undefinedのメソッド呼び出し）
      const res = await app.request('/unzen/exec/spamCheck', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ args: [null] }),
      });

      expect(res.status).toBe(400); // UnzenFunctionError → 400
      const data = await res.json();
      expect(data.error).toBeDefined();
    });
  });

  describe('Full Flow Integration', () => {
    it('should complete full flow: manifest → code → execute', async () => {
      // Step 1: Get manifest
      const manifestRes = await app.request('/unzen/manifest');
      expect(manifestRes.status).toBe(200);
      const manifest = await manifestRes.json();

      // Step 2: Get function code URL
      const addMeta = manifest.functions.add;
      expect(addMeta).toBeDefined();
      expect(addMeta.codeUrl).toBeDefined();

      // Step 3: Get function code (simulate what client does)
      const codeRes = await app.request('/unzen/code/add');
      expect(codeRes.status).toBe(200);
      const code = await codeRes.text();
      expect(code).toContain('function run');

      // Step 4: Execute via fallback
      const execRes = await app.request('/unzen/exec/add', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ args: [10, 20] }),
      });
      expect(execRes.status).toBe(200);
      const result = await execRes.json();
      expect(result.result).toBe(30);
    });
  });

  describe('Static File Serving', () => {
    it('should serve demo page', async () => {
      const res = await app.request('/');

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');

      const html = await res.text();
      expect(html).toContain('unzen core');
    });

    it('should serve client bundle', async () => {
      const res = await app.request('/client.js');

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/javascript');

      const code = await res.text();
      expect(code).toContain('UnzenClient');
    });

    it('serves the classic cache worker with update-safe headers', async () => {
      const res = await app.request('/unzen-cache-worker.js');

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/javascript');
      expect(res.headers.get('cache-control')).toBe('no-cache');
      expect(res.headers.get('service-worker-allowed')).toBe('/');
      const worker = await res.text();
      expect(worker).toContain('unzen-code-');
      expect(worker).toContain('addEventListener("fetch"');
    });
  });
});
