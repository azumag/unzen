/**
 * Server Fallback Protocol Contract Tests
 *
 * Validates the HTTP protocol contract that FallbackHandler depends on.
 * FallbackHandler (client-side) expects POST /exec/:name to return
 * `{ result, error? }` with specific shapes for success and error cases.
 *
 * These are characterization tests: no production code changes needed.
 * They guard against regressions in the server's response format that
 * would break the client's fallback path.
 *
 * Input validation and error sanitization are covered by:
 * - core/packages/server/tests/http-routes.test.ts (unit tests)
 * - core/demo/tests/integration.test.ts (E2E smoke tests)
 *
 * @see core/packages/client/src/fallback-handler.ts
 * @see core/packages/shared/src/protocol.ts (ExecutionResponse)
 */

import { describe, it, expect } from 'vitest';
import { app } from '../server';

/**
 * Helper: send a fallback request matching FallbackHandler.execute() format.
 * FallbackHandler sends POST with { args: unknown[] } body.
 */
async function fallbackRequest(name: string, args: unknown[]) {
  return app.request(`/unzen/exec/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ args }),
  });
}

// ============================================================
// Response Protocol Compliance
//
// FallbackHandler parses the response body and checks for `error` key:
// - If `data.error` exists and HTTP status >= 500 → UnzenNetworkError (retryable)
// - If `data.error` exists and HTTP status < 500 → UnzenFunctionError (not retryable)
// - If no `data.error` → return `data.result`
// Any deviation in response shape breaks fallback execution.
// ============================================================
describe('Response Protocol Compliance', () => {
  it('success response conforms to ExecutionResponse protocol', async () => {
    const res = await fallbackRequest('add', [1, 2]);

    expect(res.status).toBe(200);
    // FallbackHandler calls response.json() — must be valid JSON content type
    expect(res.headers.get('content-type')).toContain('application/json');

    const data = await res.json();

    // Server omits `error` key on success. FallbackHandler checks `if (data.error)`,
    // so absent key works correctly. We assert absence as the stronger invariant.
    expect(data.result).toBe(3);
    expect('error' in data).toBe(false);
  });

  it('nested object result survives JSON round-trip', async () => {
    const res = await fallbackRequest('getUserInfo', [
      { firstName: 'John', lastName: 'Doe', age: 25 },
    ]);

    expect(res.status).toBe(200);
    const data = await res.json();

    // Complex return value must survive JSON round-trip intact
    expect(data.result).toEqual({
      fullName: 'John Doe',
      isAdult: true,
      initials: 'JD',
    });
    expect('error' in data).toBe(false);
  });

  it('falsy result (0) is not confused with error', async () => {
    const res = await fallbackRequest('add', [0, 0]);

    expect(res.status).toBe(200);
    const data = await res.json();

    // FallbackHandler returns `data.result` — 0 must not be treated as error
    expect(data.result).toBe(0);
    expect('error' in data).toBe(false);
  });

  it('function error response conforms to ExecutionResponse protocol', async () => {
    // spamCheck(null) triggers TypeError (null.toLowerCase())
    const res = await fallbackRequest('spamCheck', [null]);

    // FallbackHandler uses status >= 500 to classify as NetworkError vs FunctionError
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('application/json');

    const data = await res.json();

    // FallbackHandler reads `data.error` as string for UnzenFunctionError message
    expect(data.result).toBeNull();
    expect(typeof data.error).toBe('string');
    expect(data.error.length).toBeGreaterThan(0);
  });

  it('404 error response conforms to ExecutionResponse protocol', async () => {
    // Non-existent function triggers 404 path in FallbackHandler
    const res = await fallbackRequest('nonExistentFunction', []);

    // FallbackHandler: status < 500 with data.error → UnzenFunctionError
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');

    const data = await res.json();

    expect(data.result).toBeNull();
    expect(typeof data.error).toBe('string');
    expect(data.error.length).toBeGreaterThan(0);
  });
});

// ============================================================
// Concurrent Fallback Requests
//
// FallbackHandler may fire concurrent requests when multiple functions
// fail browser execution simultaneously. The QuickJS runtime is shared
// across requests; this test verifies no cross-contamination occurs.
// ============================================================
describe('Concurrent Fallback Requests', () => {
  it('parallel requests to different functions return correct results', async () => {
    // Fire 4 requests in parallel — each to a different function
    const [addRes, mulRes, spamRes, statsRes] = await Promise.all([
      fallbackRequest('add', [10, 20]),
      fallbackRequest('multiply', [3, 7]),
      fallbackRequest('spamCheck', ['Hello world']),
      fallbackRequest('textStats', ['Hello world']),
    ]);

    // Verify all responses succeeded at HTTP level first
    expect([addRes.status, mulRes.status, spamRes.status, statsRes.status])
      .toEqual([200, 200, 200, 200]);

    // Each result must match its function, no cross-contamination
    const addData = await addRes.json();
    expect(addData.result).toBe(30);

    const mulData = await mulRes.json();
    expect(mulData.result).toBe(21);

    const spamData = await spamRes.json();
    expect(spamData.result).toBe(false);

    const statsData = await statsRes.json();
    expect(statsData.result.words).toBe(2);
    expect(statsData.result.chars).toBe(11);
  });
});
