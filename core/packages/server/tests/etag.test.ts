/**
 * Tests for ETag Caching on GET /manifest
 *
 * ETag caching reduces network bandwidth by allowing clients to send
 * conditional requests (If-None-Match) and receive 304 Not Modified
 * when the manifest hasn't changed.
 *
 * Test strategy:
 * - Verify ETag header is present in manifest responses
 * - Verify 304 response when If-None-Match matches current ETag
 * - Verify ETag changes when functions are registered
 * - Verify 200 response when If-None-Match does not match
 * - Verify consistent ETag for same manifest state
 * - Verify ETag works for empty manifest
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { UnzenServer } from '../src/unzen-server';

describe('ETag Caching', () => {
  let app: Hono;
  let server: UnzenServer;

  beforeEach(async () => {
    app = new Hono();
    server = new UnzenServer({ baseUrl: 'https://example.com/unzen' });
    await server.initialize();
    app.route('/unzen', server.middleware());
  });

  it('should return ETag header with manifest response', async () => {
    server.define('test', () => 1);
    const res = await app.request('/unzen/manifest');
    expect(res.status).toBe(200);
    const etag = res.headers.get('ETag');
    expect(etag).toBeTruthy();
    // Full SHA-256 hex (64 chars) in Weak ETag format: W/"<64 hex chars>"
    expect(etag).toMatch(/^W\/"[a-f0-9]{64}"/);
  });

  it('should return 304 when If-None-Match matches', async () => {
    server.define('test', () => 1);
    // First request to get ETag
    const res1 = await app.request('/unzen/manifest');
    const etag = res1.headers.get('ETag');
    expect(etag).toBeTruthy();

    // Second request with If-None-Match header matching the ETag
    // Server should respond with 304 Not Modified (no body needed)
    const res2 = await app.request('/unzen/manifest', {
      headers: { 'If-None-Match': etag! },
    });
    expect(res2.status).toBe(304);
  });

  it('should change ETag when functions are registered', async () => {
    server.define('func1', () => 1);
    const res1 = await app.request('/unzen/manifest');
    const etag1 = res1.headers.get('ETag');

    // Register a new function — manifest state changes
    server.define('func2', () => 2);
    const res2 = await app.request('/unzen/manifest');
    const etag2 = res2.headers.get('ETag');

    // ETags must differ because the manifest content changed
    expect(etag1).not.toBe(etag2);
  });

  it('should return 200 with new ETag when If-None-Match does not match', async () => {
    server.define('test', () => 1);
    // Send a stale ETag that doesn't match the current manifest
    const res = await app.request('/unzen/manifest', {
      headers: { 'If-None-Match': 'W/"stale-etag"' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('ETag')).toBeTruthy();
  });

  it('should return consistent ETag for same manifest state', async () => {
    server.define('test', () => 1);
    // Two requests to the same unchanged manifest should produce identical ETags
    // This is critical: ETag generation must be deterministic
    const res1 = await app.request('/unzen/manifest');
    const res2 = await app.request('/unzen/manifest');
    expect(res1.headers.get('ETag')).toBe(res2.headers.get('ETag'));
  });

  it('should return ETag even for empty manifest', async () => {
    // Edge case: empty manifest should still have an ETag
    // (empty manifest is still a valid manifest state)
    const res = await app.request('/unzen/manifest');
    expect(res.status).toBe(200);
    expect(res.headers.get('ETag')).toBeTruthy();
  });
});
