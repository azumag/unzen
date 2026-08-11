import { describe, expect, it } from 'vitest';
import { MAX_EXECUTION_RESPONSE_BYTES } from '@unzen/shared';
import { createExecutionHttpResponse } from '../src/execution-response';

describe('createExecutionHttpResponse', () => {
  it('serializes one JSON body with its exact encoded length', async () => {
    const response = createExecutionHttpResponse({
      success: true,
      result: '\u00e9',
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('content-length'))
      .toBe(String(Buffer.byteLength(body, 'utf8')));
    expect(JSON.parse(body)).toEqual({ result: '\u00e9' });
  });

  it('returns a bounded 422 error for an oversized result', async () => {
    const response = createExecutionHttpResponse({
      success: true,
      result: '\u00e9'.repeat(MAX_EXECUTION_RESPONSE_BYTES / 2),
    });

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      result: null,
      error: `Fallback response exceeds ${MAX_EXECUTION_RESPONSE_BYTES} bytes`,
    });
    expect(Number(response.headers.get('content-length')))
      .toBeLessThan(MAX_EXECUTION_RESPONSE_BYTES);
  });

  it('returns a bounded 422 error for a non-JSON result', async () => {
    const response = createExecutionHttpResponse({
      success: true,
      result: 1n,
    });

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      result: null,
      error: 'Fallback result is not JSON-serializable',
    });
  });

  it('replaces an oversized error without changing its status', async () => {
    const response = createExecutionHttpResponse({
      success: false,
      error: 'x'.repeat(MAX_EXECUTION_RESPONSE_BYTES),
    }, 400);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      result: null,
      error: 'Server execution failed',
    });
  });
});
