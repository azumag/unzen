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

  it('should detect forbidden globals when they are aliased before use', () => {
    const code = `
      const request = fetch;
      const Socket = WebSocket;
      function run() {
        request("https://example.com");
        return new Socket("ws://example.com");
      }
    `;

    const violations = checkForbiddenApis(code);

    expect(violations.some(v => v.includes('fetch'))).toBe(true);
    expect(violations.some(v => v.includes('WebSocket'))).toBe(true);
  });

  it('should detect static computed access through global objects', () => {
    const code = `
      globalThis["fetch"]("https://example.com");
      self['eval']("1 + 1");
      window.WebSocket;
    `;

    const violations = checkForbiddenApis(code);

    expect(violations.some(v => v.includes('fetch'))).toBe(true);
    expect(violations.some(v => v.includes('eval'))).toBe(true);
    expect(violations.some(v => v.includes('WebSocket'))).toBe(true);
  });

  it('should detect forbidden globals destructured from a global object', () => {
    const code = `
      const { fetch: request, ["WebSocket"]: Socket } = globalThis;
      request("https://example.com");
      new Socket("ws://example.com");
    `;

    const violations = checkForbiddenApis(code);

    expect(violations.some(v => v.includes('fetch'))).toBe(true);
    expect(violations.some(v => v.includes('WebSocket'))).toBe(true);
  });

  it('should detect forbidden globals assigned from global object destructuring', () => {
    const code = `
      let request;
      let Socket;
      ({ fetch: request, ["WebSocket"]: Socket } = globalThis);
    `;

    const violations = checkForbiddenApis(code);

    expect(violations.some(v => v.includes('fetch'))).toBe(true);
    expect(violations.some(v => v.includes('WebSocket'))).toBe(true);
  });

  it('should ignore forbidden API text in comments and literals', () => {
    const code = `
      // fetch("https://example.com")
      /* new WebSocket("ws://example.com") */
      const source = 'eval("1 + 1")';
      const docs = \`require("fs") and import("evil")\`;
    `;

    expect(checkForbiddenApis(code)).toHaveLength(0);
  });

  it('should ignore property names on ordinary objects', () => {
    const code = `
      const transport = {
        fetch(value) { return value; },
        WebSocket: class LocalSocket {},
      };
      transport.fetch("local");
      new transport.WebSocket();
    `;

    expect(checkForbiddenApis(code)).toHaveLength(0);
  });

  it('should allow local bindings that shadow forbidden globals', () => {
    const code = `
      function run(fetch, require) {
        const WebSocket = class LocalSocket {};
        const globalThis = { eval: value => value };
        fetch("local");
        require("local");
        globalThis.eval("local");
        return new WebSocket();
      }
    `;

    expect(checkForbiddenApis(code)).toHaveLength(0);
  });

  it('should allow imported and block-scoped bindings with forbidden names', () => {
    const code = `
      import { fetch } from "local-transport";
      fetch("local");
      {
        const eval = value => value;
        eval("local");
      }
    `;

    expect(checkForbiddenApis(code)).toHaveLength(0);
  });

  it('should report each forbidden API once', () => {
    const code = 'fetch("one"); fetch("two"); globalThis.fetch("three");';
    const violations = checkForbiddenApis(code);

    expect(violations.filter(v => v.includes('fetch'))).toHaveLength(1);
  });
});
