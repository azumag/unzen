/**
 * Tests for the MoonBit worker message protocol.
 */

import { describe, it, expect } from 'vitest';
import {
  MOONBIT_WORKER_PROTOCOL_VERSION,
  createMoonbitCancelMessage,
  createMoonbitCancelResultMessage,
  createMoonbitExecuteMessage,
  createMoonbitExecuteResultMessage,
  createMoonbitInitMessage,
  createMoonbitInitResultMessage,
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
    });

    expect(createMoonbitInitMessage(4, 'unzen:strings')).toMatchObject({
      generationId: 4,
      importedStringConstants: 'unzen:strings',
    });

    const bytes = new Uint8Array([0, 1, 2]).buffer;
    const exec = createMoonbitExecuteMessage('req-1', 'fib.wasm', bytes, true, 'fibonacci', [10], 3);
    expect(exec).toMatchObject({
      type: 'execute',
      requestId: 'req-1',
      url: 'fib.wasm',
      cacheable: true,
      exportName: 'fibonacci',
      args: [10],
      generationId: 3,
    });
    expect(exec.wasm).toBe(bytes);

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
});
