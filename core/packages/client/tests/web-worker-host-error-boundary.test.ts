import { describe, expect, it } from 'vitest';
import {
  UnzenFunctionError,
  UnzenRuntimeError,
} from '@unzen/shared';
import { WebWorkerSandboxExecutor } from '../src/web-worker-sandbox';
import {
  WORKER_PROTOCOL_VERSION,
  type WorkerMessage,
  type WorkerResponse,
} from '../src/worker/worker-protocol';

function revokedErrorProxy(): unknown {
  const { proxy, revoke } = Proxy.revocable(new Error('secret'), {});
  revoke();
  return proxy;
}

function hostileObject(calls: { count: number }): object {
  const fail = () => {
    calls.count += 1;
    throw new Error('coercion hook must not run');
  };
  return {
    [Symbol.toPrimitive]: fail,
    valueOf: fail,
    toString: fail,
  };
}

function workerFactory(worker: object): (url: string | URL) => Worker {
  return () => worker as Worker;
}

function healthyInitWorker(options: {
  executeFailure?: unknown;
  onErrorSetterFailure?: unknown;
} = {}): object {
  let onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null = null;
  let onerror: ((event: ErrorEvent) => void) | null = null;

  return {
    get onmessage() {
      return onmessage;
    },
    set onmessage(handler: ((event: MessageEvent<WorkerResponse>) => void) | null) {
      onmessage = handler;
    },
    get onerror() {
      return onerror;
    },
    set onerror(handler: ((event: ErrorEvent) => void) | null) {
      if (options.onErrorSetterFailure !== undefined) {
        throw options.onErrorSetterFailure;
      }
      onerror = handler;
    },
    postMessage(message: WorkerMessage) {
      if (message.type === 'init') {
        queueMicrotask(() => {
          onmessage?.({
            data: {
              protocolVersion: WORKER_PROTOCOL_VERSION,
              generationId: message.generationId,
              type: 'init-result',
              success: true,
            },
          } as MessageEvent<WorkerResponse>);
        });
        return;
      }
      if (message.type === 'execute' && options.executeFailure !== undefined) {
        throw options.executeFailure;
      }
    },
    terminate() {},
  };
}

describe('WebWorkerSandboxExecutor host error boundary', () => {
  it('fails closed when a custom Worker factory throws a revoked Proxy', async () => {
    const executor = new WebWorkerSandboxExecutor({
      workerUrl: '/worker.js',
      createWorker: () => {
        throw revokedErrorProxy();
      },
    });

    await expect(executor.execute('function run() { return 1; }', []))
      .rejects.toMatchObject({
        name: 'UnzenRuntimeError',
        message: 'Failed to create Worker: Unknown error',
      });
    executor.dispose();
  });

  it('does not coerce hostile values thrown while configuring a custom Worker', async () => {
    const calls = { count: 0 };
    const executor = new WebWorkerSandboxExecutor({
      workerUrl: '/worker.js',
      createWorker: workerFactory(healthyInitWorker({
        onErrorSetterFailure: hostileObject(calls),
      })),
    });

    await expect(executor.execute('function run() { return 1; }', []))
      .rejects.toMatchObject({
        name: 'UnzenRuntimeError',
        message: 'Failed to configure Worker: Unknown error',
      });
    expect(calls.count).toBe(0);
    executor.dispose();
  });

  it('does not coerce hostile values thrown by execute postMessage', async () => {
    const calls = { count: 0 };
    const executor = new WebWorkerSandboxExecutor({
      workerUrl: '/worker.js',
      createWorker: workerFactory(healthyInitWorker({
        executeFailure: hostileObject(calls),
      })),
    });

    await expect(executor.execute('function run() { return 1; }', []))
      .rejects.toMatchObject({
        name: 'UnzenRuntimeError',
        message: 'Failed to send execute message: Unknown error',
      });
    expect(calls.count).toBe(0);
    executor.dispose();
  });

  it('normalizes hostile structural AbortSignal subscription failures as function errors', async () => {
    const calls = { count: 0 };
    const failure = hostileObject(calls);
    const signal = {
      aborted: false,
      addEventListener() {
        throw failure;
      },
      removeEventListener() {},
    } as unknown as AbortSignal;
    let factoryCalls = 0;
    const executor = new WebWorkerSandboxExecutor({
      workerUrl: '/worker.js',
      createWorker: () => {
        factoryCalls += 1;
        return healthyInitWorker() as Worker;
      },
    });

    const rejection = executor.execute('function run() { return 1; }', [], { signal });
    await expect(rejection).rejects.toBeInstanceOf(UnzenFunctionError);
    await expect(rejection).rejects.toThrow('QuickJS execution signal could not be subscribed');
    expect(calls.count).toBe(0);
    expect(factoryCalls).toBe(0);
    executor.dispose();
  });

  it('normalizes hostile option/call access before Worker creation', async () => {
    const calls = { count: 0 };
    const failure = hostileObject(calls);
    let factoryCalls = 0;
    const executor = new WebWorkerSandboxExecutor({
      workerUrl: '/worker.js',
      createWorker: () => {
        factoryCalls += 1;
        return healthyInitWorker() as Worker;
      },
    });
    const options = new Proxy({}, {
      get(_target, property) {
        if (property === 'signal') throw failure;
        return undefined;
      },
    });
    const args = new Proxy<unknown[]>([], {
      get(target, property, receiver) {
        if (property === 'length') throw failure;
        return Reflect.get(target, property, receiver);
      },
    });

    await expect(executor.execute('function run() { return 1; }', [], options))
      .rejects.toBeInstanceOf(UnzenFunctionError);
    await expect(executor.execute('function run() { return 1; }', args))
      .rejects.toBeInstanceOf(UnzenFunctionError);
    expect(calls.count).toBe(0);
    expect(factoryCalls).toBe(0);
    executor.dispose();
  });

  it('rejects revoked constructor option containers with a stable diagnostic', () => {
    const { proxy, revoke } = Proxy.revocable({ workerUrl: '/worker.js' }, {});
    revoke();

    expect(() => new WebWorkerSandboxExecutor(proxy))
      .toThrow('Worker executor options must be an object');
  });

  it('keeps ordinary runtime Error diagnostics useful', async () => {
    const executor = new WebWorkerSandboxExecutor({
      workerUrl: '/worker.js',
      createWorker: workerFactory(healthyInitWorker({
        executeFailure: new Error('DataCloneError: value could not be cloned'),
      })),
    });

    const rejection = executor.execute('function run() { return 1; }', []);
    await expect(rejection).rejects.toBeInstanceOf(UnzenRuntimeError);
    await expect(rejection).rejects.toThrow(
      'Failed to send execute message: DataCloneError: value could not be cloned',
    );
    executor.dispose();
  });
});
