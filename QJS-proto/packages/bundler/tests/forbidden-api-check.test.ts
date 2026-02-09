/**
 * Tests for forbidden API detection in bundled code
 *
 * After esbuild bundles code, we scan the output for APIs that
 * would be blocked by the sandbox but might slip through via npm deps.
 */

import { describe, it, expect } from 'vitest';
import { checkForbiddenApis } from '../src/forbidden-api-check';

describe('forbidden-api-check', () => {
  it('should detect fetch() call', () => {
    const code = 'function run() { return fetch("https://example.com"); }';
    const violations = checkForbiddenApis(code);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some(v => v.includes('fetch'))).toBe(true);
  });

  it('should detect XMLHttpRequest', () => {
    const code = 'function run() { return new XMLHttpRequest(); }';
    const violations = checkForbiddenApis(code);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some(v => v.includes('XMLHttpRequest'))).toBe(true);
  });

  it('should detect WebSocket', () => {
    const code = 'function run() { return new WebSocket("ws://example.com"); }';
    const violations = checkForbiddenApis(code);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some(v => v.includes('WebSocket'))).toBe(true);
  });

  it('should detect importScripts', () => {
    const code = 'function run() { importScripts("evil.js"); }';
    const violations = checkForbiddenApis(code);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some(v => v.includes('importScripts'))).toBe(true);
  });

  it('should detect eval(', () => {
    const code = 'function run() { return eval("1+1"); }';
    const violations = checkForbiddenApis(code);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some(v => v.includes('eval'))).toBe(true);
  });

  it('should pass clean computation code', () => {
    const code = 'function run(a, b) { return a + b; }';
    const violations = checkForbiddenApis(code);
    expect(violations).toHaveLength(0);
  });

  it('should pass code with array methods', () => {
    const code = 'function run(arr) { return arr.map(x => x * 2).filter(x => x > 5); }';
    const violations = checkForbiddenApis(code);
    expect(violations).toHaveLength(0);
  });

  it('should detect multiple violations', () => {
    const code = 'function run() { fetch("url"); new WebSocket("ws://evil"); }';
    const violations = checkForbiddenApis(code);
    expect(violations.length).toBeGreaterThanOrEqual(2);
  });

  // Review fix: Detect alternate references to forbidden APIs
  it('should detect self.fetch()', () => {
    const code = 'function run() { return self.fetch("https://example.com"); }';
    const violations = checkForbiddenApis(code);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some(v => v.includes('fetch'))).toBe(true);
  });

  it('should detect globalThis.eval()', () => {
    const code = 'function run() { return globalThis.eval("1+1"); }';
    const violations = checkForbiddenApis(code);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some(v => v.includes('eval'))).toBe(true);
  });

  it('should detect Function constructor', () => {
    const code = 'function run() { return new Function("return 1")(); }';
    const violations = checkForbiddenApis(code);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some(v => v.includes('Function'))).toBe(true);
  });

  it('should detect require() calls', () => {
    const code = 'function run() { const fs = require("fs"); }';
    const violations = checkForbiddenApis(code);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some(v => v.includes('require'))).toBe(true);
  });

  it('should detect dynamic import()', () => {
    const code = 'async function run() { const m = await import("evil"); }';
    const violations = checkForbiddenApis(code);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some(v => v.includes('import'))).toBe(true);
  });
});
