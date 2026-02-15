/**
 * Tests for the main bundler module
 *
 * The bundler takes function code with npm imports and produces
 * self-contained code that can run in the QuickJS sandbox.
 */

import { describe, it, expect } from 'vitest';
import { bundle } from '../src/bundler';

describe('bundler', () => {
  it('should bundle simple code without imports', async () => {
    const result = await bundle({
      code: `export function run(a, b) { return a + b; }`,
      allowedModules: [],
    });

    expect(result.code).toBeDefined();
    expect(result.code.length).toBeGreaterThan(0);
    expect(result.size).toBeGreaterThan(0);
    expect(result.modules).toEqual([]);
  });

  it('should produce code containing function run', async () => {
    const result = await bundle({
      code: `export function run(x) { return x * 2; }`,
      allowedModules: [],
    });

    expect(result.code).toContain('run');
  });

  it('should report bundle size in bytes', async () => {
    const result = await bundle({
      code: `export function run() { return 42; }`,
      allowedModules: [],
    });

    expect(typeof result.size).toBe('number');
    expect(result.size).toBeGreaterThan(0);
  });

  it('should reject code with forbidden Node.js built-in imports', async () => {
    await expect(bundle({
      code: `import { readFileSync } from 'fs'; export function run() { return readFileSync('/etc/passwd'); }`,
      allowedModules: ['fs'],  // Even if "allowed", fs is a Node built-in
    })).rejects.toThrow(/fs/);
  });

  it('should reject code with non-whitelisted module imports', async () => {
    await expect(bundle({
      code: `import axios from 'axios'; export function run() { return axios.get('https://example.com'); }`,
      allowedModules: ['lodash'],  // axios not in the list
    })).rejects.toThrow(/axios/);
  });

  it('should reject code containing forbidden APIs after bundling', async () => {
    await expect(bundle({
      code: `export function run() { return fetch("https://evil.com"); }`,
      allowedModules: [],
    })).rejects.toThrow(/fetch/);
  });

  it('should use ES2018 target for QuickJS compatibility', async () => {
    // ES2018 should work; optional chaining (ES2020) should be transpiled
    const result = await bundle({
      code: `export function run(obj) { return obj?.value ?? 'default'; }`,
      allowedModules: [],
    });

    // The bundled output should NOT contain ?. (optional chaining)
    // because ES2018 doesn't support it - esbuild should transpile
    expect(result.code).not.toContain('?.');
    expect(result.code).not.toContain('??');
  });

  it('should return empty modules array for code without imports', async () => {
    const result = await bundle({
      code: `export function run() { return 'hello'; }`,
      allowedModules: [],
    });

    expect(result.modules).toEqual([]);
  });

  // Review fix: esbuild plugin validates modules at resolve time
  it('should reject dynamic require() of forbidden modules', async () => {
    await expect(bundle({
      code: `export function run() { const m = require('child_process'); return m; }`,
      allowedModules: [],
    })).rejects.toThrow(/require|child_process/);
  });

  it('should reject path traversal in imports', async () => {
    await expect(bundle({
      code: `import evil from 'lodash/../../fs-extra'; export function run() { return evil; }`,
      allowedModules: ['lodash/*'],
    })).rejects.toThrow(/traversal|lodash/);
  });

  // Review fix: esbuild plugin validates ALL module resolution, not just source imports
  it('should use esbuild plugin to validate modules at resolution time', async () => {
    // This test verifies the esbuild onResolve plugin is active.
    // Even modules that aren't visible in source code import statements
    // should be caught at resolution time.
    await expect(bundle({
      code: `import net from 'net'; export function run() { return net; }`,
      allowedModules: [],
    })).rejects.toThrow(/net/);
  });
});
