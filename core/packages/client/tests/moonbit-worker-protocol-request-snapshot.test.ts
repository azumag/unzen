import { describe, expect, it } from 'vitest';
import {
  MOONBIT_WORKER_PROTOCOL_VERSION,
  validateMoonbitWorkerRequest,
} from '../src/worker/moonbit-worker-protocol';

describe('validateMoonbitWorkerRequest snapshot boundary', () => {
  it('captures execute fields exactly once and returns a plain snapshot', () => {
    const reads = new Map<string, number>();
    const once = <T>(name: string, value: T): T => {
      const count = (reads.get(name) ?? 0) + 1;
      reads.set(name, count);
      if (count > 1) throw new Error(`${name} read more than once`);
      return value;
    };
    const wasm = new Uint8Array([0, 1, 2]).buffer;
    const args = [[1, 2, 3]];
    const moonbitAbi = { params: ['i32[]'] as const, result: 'i32[]' as const };
    const request = {
      get protocolVersion() { return once('protocolVersion', MOONBIT_WORKER_PROTOCOL_VERSION); },
      get generationId() { return once('generationId', 7); },
      get type() { return once('type', 'execute' as const); },
      get requestId() { return once('requestId', 'req-7'); },
      get wasm() { return once('wasm', wasm); },
      get cacheKey() { return once('cacheKey', 'module@sha256'); },
      get cacheable() { return once('cacheable', true); },
      get exportName() { return once('exportName', 'run'); },
      get args() { return once('args', args); },
      get moonbitAbi() { return once('moonbitAbi', moonbitAbi); },
    };

    const result = validateMoonbitWorkerRequest(request);

    expect(result.ok).toBe(true);
    if (!result.ok || result.msg.type !== 'execute') return;
    expect(result.msg).toEqual({
      type: 'execute',
      requestId: 'req-7',
      protocolVersion: MOONBIT_WORKER_PROTOCOL_VERSION,
      generationId: 7,
      cacheKey: 'module@sha256',
      wasm,
      cacheable: true,
      exportName: 'run',
      args,
      moonbitAbi,
    });
    expect(result.msg === request).toBe(false);
    expect(result.msg.wasm).toBe(wasm);
    expect(result.msg.args).toBe(args);
    expect(result.msg.moonbitAbi).toBe(moonbitAbi);
    for (const field of [
      'protocolVersion',
      'generationId',
      'type',
      'requestId',
      'wasm',
      'cacheKey',
      'cacheable',
      'exportName',
      'args',
      'moonbitAbi',
    ]) {
      expect(reads.get(field)).toBe(1);
      expect(Object.getOwnPropertyDescriptor(result.msg, field)?.get).toBeUndefined();
    }
  });

  it('captures init and cancel fields exactly once', () => {
    const initReads = new Map<string, number>();
    const initOnce = <T>(name: string, value: T): T => {
      const count = (initReads.get(name) ?? 0) + 1;
      initReads.set(name, count);
      if (count > 1) throw new Error(`${name} read more than once`);
      return value;
    };
    const init = {
      get protocolVersion() { return initOnce('protocolVersion', MOONBIT_WORKER_PROTOCOL_VERSION); },
      get generationId() { return initOnce('generationId', 1); },
      get type() { return initOnce('type', 'init' as const); },
      get importedStringConstants() { return initOnce('importedStringConstants', 'unzen:strings'); },
      get maxCachedModules() { return initOnce('maxCachedModules', 2); },
    };

    const cancelReads = new Map<string, number>();
    const cancelOnce = <T>(name: string, value: T): T => {
      const count = (cancelReads.get(name) ?? 0) + 1;
      cancelReads.set(name, count);
      if (count > 1) throw new Error(`${name} read more than once`);
      return value;
    };
    const cancel = {
      get protocolVersion() { return cancelOnce('protocolVersion', MOONBIT_WORKER_PROTOCOL_VERSION); },
      get generationId() { return cancelOnce('generationId', 2); },
      get type() { return cancelOnce('type', 'cancel' as const); },
      get requestId() { return cancelOnce('requestId', 'req-cancel'); },
    };

    expect(validateMoonbitWorkerRequest(init)).toEqual({
      ok: true,
      msg: {
        type: 'init',
        protocolVersion: MOONBIT_WORKER_PROTOCOL_VERSION,
        generationId: 1,
        importedStringConstants: 'unzen:strings',
        maxCachedModules: 2,
      },
    });
    expect(validateMoonbitWorkerRequest(cancel)).toEqual({
      ok: true,
      msg: {
        type: 'cancel',
        requestId: 'req-cancel',
        protocolVersion: MOONBIT_WORKER_PROTOCOL_VERSION,
        generationId: 2,
      },
    });
    expect([...initReads.values()]).toEqual(new Array(5).fill(1));
    expect([...cancelReads.values()]).toEqual(new Array(4).fill(1));
  });

  it('keeps captured execute fields stable after source mutation', () => {
    const wasm = new Uint8Array([1, 2, 3]).buffer;
    const replacementWasm = new Uint8Array([9]).buffer;
    const args = [[1, 2]];
    const replacementArgs = [[9, 9]];
    const moonbitAbi = { params: ['i32[]'] as const, result: 'i32[]' as const };
    const replacementAbi = { params: ['f64[]'] as const, result: 'f64[]' as const };
    const request: Record<string, unknown> = {
      type: 'execute',
      requestId: 'req-original',
      protocolVersion: MOONBIT_WORKER_PROTOCOL_VERSION,
      generationId: 3,
      cacheKey: 'original-key',
      wasm,
      cacheable: true,
      exportName: 'run',
      args,
      moonbitAbi,
    };

    const result = validateMoonbitWorkerRequest(request);
    expect(result.ok).toBe(true);
    if (!result.ok || result.msg.type !== 'execute') return;

    request.type = 'cancel';
    request.requestId = 'req-mutated';
    request.generationId = 99;
    request.cacheKey = 'mutated-key';
    request.wasm = replacementWasm;
    request.cacheable = false;
    request.exportName = 'mutated';
    request.args = replacementArgs;
    request.moonbitAbi = replacementAbi;

    expect(result.msg.type).toBe('execute');
    expect(result.msg.requestId).toBe('req-original');
    expect(result.msg.generationId).toBe(3);
    expect(result.msg.cacheKey).toBe('original-key');
    expect(result.msg.wasm).toBe(wasm);
    expect(result.msg.cacheable).toBe(true);
    expect(result.msg.exportName).toBe('run');
    expect(result.msg.args).toBe(args);
    expect(result.msg.moonbitAbi).toBe(moonbitAbi);
  });

  it('rejects unreadable request accessors without throwing', () => {
    const request = new Proxy({}, {
      get() {
        throw new Error('boom');
      },
    });

    expect(validateMoonbitWorkerRequest(request)).toEqual({
      ok: false,
      reason: 'request could not be read',
    });
  });
});
