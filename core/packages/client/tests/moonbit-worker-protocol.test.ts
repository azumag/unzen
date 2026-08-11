/**
 * Tests for the MoonBit worker message protocol.
 */

import { describe, it, expect } from 'vitest';
import { DEFAULT_MAX_MOONBIT_CACHED_MODULES } from '../src/moonbit-cache';
import {
  MOONBIT_WORKER_PROTOCOL_VERSION,
  createMoonbitCancelMessage,
  createMoonbitCancelResultMessage,
  createMoonbitExecuteMessage,
  createMoonbitExecuteResultMessage,
  createMoonbitInitMessage,
  createMoonbitInitResultMessage,
  validateMoonbitWorkerRequest,
  validateMoonbitWorkerResponse,
} from '../src/worker/moonbit-worker-protocol';

describe('MoonBit worker protocol', () => {
  it('builds init/execute/cancel messages with version and generation', () => {
    const init = createMoonbitInitMessage(3);
    expect(init).toMatchObject({
      type: 'init',
      protocolVersion: MOONBIT_WORKER_PROTOCOL_VERSION,
      generationId: 3,
      importedStringConstants: '_',
      maxCachedModules: DEFAULT_MAX_MOONBIT_CACHED_MODULES,
    });

    expect(createMoonbitInitMessage(4, 'unzen:strings', 2)).toMatchObject({
      generationId: 4,
      importedStringConstants: 'unzen:strings',
      maxCachedModules: 2,
    });

    const bytes = new Uint8Array([0, 1, 2]).buffer;
    const exec = createMoonbitExecuteMessage('req-1', 'fib.wasm', bytes, true, 'fibonacci', [10], 3);
    expect(exec).toMatchObject({
      type: 'execute',
      requestId: 'req-1',
      cacheKey: 'fib.wasm',
      cacheable: true,
      exportName: 'fibonacci',
      args: [10],
      generationId: 3,
    });
    expect(exec.wasm).toBe(bytes);

    const arrayExec = createMoonbitExecuteMessage(
      'req-2',
      'arrays.wasm',
      bytes,
      true,
      'reverse_array',
      [[1, 2, 3]],
      3,
      { params: ['i32[]'], result: 'i32[]' },
    );
    expect(arrayExec.moonbitAbi).toEqual({ params: ['i32[]'], result: 'i32[]' });

    const cancel = createMoonbitCancelMessage('req-1', 3);
    expect(cancel).toMatchObject({ type: 'cancel', requestId: 'req-1', generationId: 3 });
  });

  it('builds result messages', () => {
    expect(createMoonbitInitResultMessage(true, 3)).toMatchObject({
      type: 'init-result',
      success: true,
      generationId: 3,
    });
    expect(createMoonbitExecuteResultMessage('req-1', true, 3, 55)).toMatchObject({
      type: 'execute-result',
      requestId: 'req-1',
      success: true,
      value: 55,
      generationId: 3,
    });
    expect(createMoonbitCancelResultMessage('req-1', true, 3)).toMatchObject({
      type: 'cancel-result',
      requestId: 'req-1',
      success: true,
      generationId: 3,
    });
    expect(createMoonbitExecuteResultMessage('req-null', true, 3, null)).toMatchObject({
      success: true,
      value: null,
    });
  });

  it('validates request envelopes before worker state is touched', () => {
    const bytes = new Uint8Array([0, 1, 2]).buffer;
    expect(validateMoonbitWorkerRequest(createMoonbitInitMessage(1)).ok).toBe(true);
    expect(validateMoonbitWorkerRequest(createMoonbitExecuteMessage(
      'req-1',
      'module@hash',
      bytes,
      true,
      'run',
      [],
      1,
    )).ok).toBe(true);
    expect(validateMoonbitWorkerRequest(createMoonbitCancelMessage('req-1', 1)).ok).toBe(true);

    expect(validateMoonbitWorkerRequest(null).ok).toBe(false);
    const { maxCachedModules: _omitted, ...missingCacheLimit } = createMoonbitInitMessage(1);
    expect(validateMoonbitWorkerRequest(missingCacheLimit).ok).toBe(false);
    expect(validateMoonbitWorkerRequest({
      ...createMoonbitInitMessage(1),
      maxCachedModules: -1,
    }).ok).toBe(false);
    expect(validateMoonbitWorkerRequest({
      ...createMoonbitExecuteMessage('req-1', 'module@hash', bytes, true, 'run', [], 1),
      wasm: new Uint8Array([0, 1, 2]),
    }).ok).toBe(false);
    expect(validateMoonbitWorkerRequest({
      ...createMoonbitExecuteMessage('req-1', 'module@hash', bytes, true, 'run', [], 1),
      moonbitAbi: { params: ['unsupported'] },
    }).ok).toBe(false);
  });

  it('validates well-formed responses', () => {
    const ok = validateMoonbitWorkerResponse({
      type: 'execute-result',
      requestId: 'req-1',
      success: true,
      value: 42,
      protocolVersion: MOONBIT_WORKER_PROTOCOL_VERSION,
      generationId: 1,
    });
    expect(ok.ok).toBe(true);
  });

  it('rejects response objects whose fields cannot be read', () => {
    const response = new Proxy({}, {
      get() {
        throw new Error('boom');
      },
    });
    const result = validateMoonbitWorkerResponse(response);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('could not be read');
  });

  it('rejects missing version / generation / unknown types', () => {
    const missingVersion = validateMoonbitWorkerResponse({
      type: 'init-result',
      success: true,
      generationId: 1,
    });
    expect(missingVersion.ok).toBe(false);
    if (!missingVersion.ok) expect(missingVersion.reason).toContain('protocol version');

    const missingGen = validateMoonbitWorkerResponse({
      type: 'init-result',
      success: true,
      protocolVersion: MOONBIT_WORKER_PROTOCOL_VERSION,
    });
    expect(missingGen.ok).toBe(false);
    if (!missingGen.ok) expect(missingGen.reason).toContain('generationId');

    const badType = validateMoonbitWorkerResponse({
      type: 'bogus',
      protocolVersion: MOONBIT_WORKER_PROTOCOL_VERSION,
      generationId: 1,
    });
    expect(badType.ok).toBe(false);
    if (!badType.ok) expect(badType.reason).toContain('unknown message type');
  });

  it.each([-1, Number.MAX_SAFE_INTEGER + 1])(
    'rejects an out-of-range generation id (%s)',
    (generationId) => {
      const result = validateMoonbitWorkerResponse({
        type: 'init-result',
        success: true,
        protocolVersion: MOONBIT_WORKER_PROTOCOL_VERSION,
        generationId,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain('generationId');
    },
  );

  it('rejects array responses and malformed failure envelopes', () => {
    const array = Object.assign([], {
      type: 'init-result',
      success: true,
      protocolVersion: MOONBIT_WORKER_PROTOCOL_VERSION,
      generationId: 1,
    });
    expect(validateMoonbitWorkerResponse(array).ok).toBe(false);
    expect(validateMoonbitWorkerResponse({
      type: 'execute-result',
      requestId: 'req-1',
      success: false,
      error: 42,
      errorType: 'runtime_error',
      protocolVersion: MOONBIT_WORKER_PROTOCOL_VERSION,
      generationId: 1,
    }).ok).toBe(false);
    const missingType = validateMoonbitWorkerResponse({
      type: 'execute-result',
      requestId: 'req-1',
      success: false,
      error: 'failed',
      protocolVersion: MOONBIT_WORKER_PROTOCOL_VERSION,
      generationId: 1,
    });
    expect(missingType.ok).toBe(false);
    if (!missingType.ok) expect(missingType.reason).toContain('errorType');
  });
});
