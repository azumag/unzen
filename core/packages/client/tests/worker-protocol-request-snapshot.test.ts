import { describe, expect, it } from 'vitest';
import {
  WORKER_PROTOCOL_VERSION,
  validateWorkerRequest,
} from '../src/worker/worker-protocol';

describe('validateWorkerRequest snapshot boundary', () => {
  it('captures execute fields exactly once and returns a plain snapshot', () => {
    const reads = new Map<string, number>();
    const once = <T>(name: string, value: T): T => {
      const count = (reads.get(name) ?? 0) + 1;
      reads.set(name, count);
      if (count > 1) throw new Error(`${name} read more than once`);
      return value;
    };
    const args = [{ value: 1 }];
    const request = {
      get protocolVersion() { return once('protocolVersion', WORKER_PROTOCOL_VERSION); },
      get generationId() { return once('generationId', 7); },
      get type() { return once('type', 'execute' as const); },
      get requestId() { return once('requestId', 'req-7'); },
      get code() { return once('code', 'function run(value) { return value; }'); },
      get args() { return once('args', args); },
      get timeout() { return once('timeout', 50); },
    };

    const result = validateWorkerRequest(request);

    expect(result.ok).toBe(true);
    if (!result.ok || result.msg.type !== 'execute') return;
    expect(result.msg).toEqual({
      type: 'execute',
      requestId: 'req-7',
      protocolVersion: WORKER_PROTOCOL_VERSION,
      generationId: 7,
      code: 'function run(value) { return value; }',
      args,
      timeout: 50,
    });
    // Compare identity before handing either object to a matcher so Vitest does
    // not inspect the hostile getter-backed source while formatting values.
    expect(result.msg === request).toBe(false);
    expect(result.msg.args).toBe(args);
    for (const field of [
      'protocolVersion',
      'generationId',
      'type',
      'requestId',
      'code',
      'args',
      'timeout',
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
      get protocolVersion() { return initOnce('protocolVersion', WORKER_PROTOCOL_VERSION); },
      get generationId() { return initOnce('generationId', 1); },
      get type() { return initOnce('type', 'init' as const); },
    };

    const cancelReads = new Map<string, number>();
    const cancelOnce = <T>(name: string, value: T): T => {
      const count = (cancelReads.get(name) ?? 0) + 1;
      cancelReads.set(name, count);
      if (count > 1) throw new Error(`${name} read more than once`);
      return value;
    };
    const cancel = {
      get protocolVersion() { return cancelOnce('protocolVersion', WORKER_PROTOCOL_VERSION); },
      get generationId() { return cancelOnce('generationId', 2); },
      get type() { return cancelOnce('type', 'cancel' as const); },
      get requestId() { return cancelOnce('requestId', 'req-cancel'); },
    };

    expect(validateWorkerRequest(init)).toEqual({
      ok: true,
      msg: {
        type: 'init',
        protocolVersion: WORKER_PROTOCOL_VERSION,
        generationId: 1,
      },
    });
    expect(validateWorkerRequest(cancel)).toEqual({
      ok: true,
      msg: {
        type: 'cancel',
        requestId: 'req-cancel',
        protocolVersion: WORKER_PROTOCOL_VERSION,
        generationId: 2,
      },
    });
    expect([...initReads.values()]).toEqual(new Array(3).fill(1));
    expect([...cancelReads.values()]).toEqual(new Array(4).fill(1));
  });

  it('keeps captured execute scalars and args reference stable after source mutation', () => {
    const originalArgs = [1, 2];
    const replacementArgs = [9, 9];
    const request: Record<string, unknown> = {
      type: 'execute',
      requestId: 'req-original',
      protocolVersion: WORKER_PROTOCOL_VERSION,
      generationId: 3,
      code: 'function run() { return 1; }',
      args: originalArgs,
      timeout: 25,
    };

    const result = validateWorkerRequest(request);
    expect(result.ok).toBe(true);
    if (!result.ok || result.msg.type !== 'execute') return;

    request.type = 'cancel';
    request.requestId = 'req-mutated';
    request.generationId = 99;
    request.code = 'mutated';
    request.args = replacementArgs;
    request.timeout = 999;

    expect(result.msg.type).toBe('execute');
    expect(result.msg.requestId).toBe('req-original');
    expect(result.msg.generationId).toBe(3);
    expect(result.msg.code).toBe('function run() { return 1; }');
    expect(result.msg.args).toBe(originalArgs);
    expect(result.msg.timeout).toBe(25);
  });

  it('snapshots init and cancel messages instead of retaining caller objects', () => {
    const init = {
      type: 'init',
      protocolVersion: WORKER_PROTOCOL_VERSION,
      generationId: 1,
    };
    const cancel = {
      type: 'cancel',
      requestId: 'req-cancel',
      protocolVersion: WORKER_PROTOCOL_VERSION,
      generationId: 2,
    };

    const initResult = validateWorkerRequest(init);
    const cancelResult = validateWorkerRequest(cancel);

    expect(initResult).toEqual({ ok: true, msg: init });
    expect(cancelResult).toEqual({ ok: true, msg: cancel });
    expect(initResult.ok && initResult.msg === init).toBe(false);
    expect(cancelResult.ok && cancelResult.msg === cancel).toBe(false);
  });

  it('rejects unreadable request accessors without throwing', () => {
    const request = new Proxy({}, {
      get() {
        throw new Error('boom');
      },
    });

    expect(validateWorkerRequest(request)).toEqual({
      ok: false,
      reason: 'request could not be read',
    });
  });
});
