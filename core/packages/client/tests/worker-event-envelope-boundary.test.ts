import { describe, expect, it } from 'vitest';
import { UnzenRuntimeError } from '@unzen/shared';
import { WebWorkerSandboxExecutor } from '../src/web-worker-sandbox';
import {
  WORKER_PROTOCOL_VERSION,
  type WorkerMessage,
  type WorkerResponse,
} from '../src/worker/worker-protocol';

function hostileEnvelope(field: 'data' | 'message', coercionReads: { count: number }): object {
  const envelope = {
    get [field](): never {
      throw new Error(`${field} getter must be bounded`);
    },
    [Symbol.toPrimitive]() {
      coercionReads.count += 1;
      throw new Error('event coercion must not run');
    },
    valueOf() {
      coercionReads.count += 1;
      throw new Error('event coercion must not run');
    },
    toString() {
      coercionReads.count += 1;
      throw new Error('event coercion must not run');
    },
  };
  return envelope;
}

type EventMode = 'init-hostile-data' | 'runtime-hostile-data' | 'init-hostile-error' | 'healthy-read-once';

class EventEnvelopeWorker {
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly coercionReads = { count: 0 };
  readonly dataReads = { count: 0 };

  constructor(private readonly mode: EventMode) {}

  postMessage(message: WorkerMessage): void {
    if (message.type === 'init') {
      if (this.mode === 'init-hostile-data') {
        const event = hostileEnvelope('data', this.coercionReads);
        queueMicrotask(() => this.onmessage?.(event as MessageEvent<WorkerResponse>));
        return;
      }
      if (this.mode === 'init-hostile-error') {
        const event = hostileEnvelope('message', this.coercionReads);
        queueMicrotask(() => this.onerror?.(event as ErrorEvent));
        return;
      }

      const data: WorkerResponse = {
        protocolVersion: WORKER_PROTOCOL_VERSION,
        generationId: message.generationId,
        type: 'init-result',
        success: true,
      };
      const event = this.mode === 'healthy-read-once'
        ? {
            get data() {
              // `this` is the event object, so close over the worker explicitly below.
              return data;
            },
          }
        : { data };
      if (this.mode === 'healthy-read-once') {
        Object.defineProperty(event, 'data', {
          configurable: true,
          get: () => {
            this.dataReads.count += 1;
            return data;
          },
        });
      }
      queueMicrotask(() => this.onmessage?.(event as MessageEvent<WorkerResponse>));
      return;
    }

    if (message.type === 'execute') {
      if (this.mode === 'runtime-hostile-data') {
        const event = hostileEnvelope('data', this.coercionReads);
        queueMicrotask(() => this.onmessage?.(event as MessageEvent<WorkerResponse>));
        return;
      }
      const data: WorkerResponse = {
        protocolVersion: WORKER_PROTOCOL_VERSION,
        generationId: message.generationId,
        type: 'execute-result',
        requestId: message.requestId,
        success: true,
        value: 'ok',
      };
      const event: { data?: WorkerResponse } = {};
      Object.defineProperty(event, 'data', {
        configurable: true,
        get: () => {
          this.dataReads.count += 1;
          return data;
        },
      });
      queueMicrotask(() => this.onmessage?.(event as MessageEvent<WorkerResponse>));
    }
  }

  terminate(): void {}
}

function createExecutor(worker: EventEnvelopeWorker): WebWorkerSandboxExecutor {
  return new WebWorkerSandboxExecutor({
    workerUrl: '/worker.js',
    createWorker: () => worker as unknown as Worker,
  });
}

describe('custom Worker event envelope boundary', () => {
  it('classifies an unreadable init MessageEvent.data as a malformed response', async () => {
    const worker = new EventEnvelopeWorker('init-hostile-data');
    const executor = createExecutor(worker);

    const rejection = executor.execute('function run() { return 1; }', []);
    await expect(rejection).rejects.toBeInstanceOf(UnzenRuntimeError);
    await expect(rejection).rejects.toThrow('Malformed worker init response');
    expect(executor.diagnostics.malformedResponseCount).toBe(1);
    expect(worker.coercionReads.count).toBe(0);
    executor.dispose();
  });

  it('classifies an unreadable runtime MessageEvent.data as a generation-fatal malformed response', async () => {
    const worker = new EventEnvelopeWorker('runtime-hostile-data');
    const executor = createExecutor(worker);

    const rejection = executor.execute('function run() { return 1; }', []);
    await expect(rejection).rejects.toBeInstanceOf(UnzenRuntimeError);
    await expect(rejection).rejects.toThrow('Malformed worker response');
    expect(executor.diagnostics.malformedResponseCount).toBe(1);
    expect(executor.diagnostics.forcedTerminationCount).toBe(1);
    expect(worker.coercionReads.count).toBe(0);
    executor.dispose();
  });

  it('normalizes an unreadable Worker error-event message without coercion', async () => {
    const worker = new EventEnvelopeWorker('init-hostile-error');
    const executor = createExecutor(worker);

    const rejection = executor.execute('function run() { return 1; }', []);
    await expect(rejection).rejects.toBeInstanceOf(UnzenRuntimeError);
    await expect(rejection).rejects.toThrow('Worker error during initialization: unknown error');
    expect(worker.coercionReads.count).toBe(0);
    executor.dispose();
  });

  it('reads each valid custom Worker MessageEvent.data exactly once', async () => {
    const worker = new EventEnvelopeWorker('healthy-read-once');
    const executor = createExecutor(worker);

    await expect(executor.execute('function run() { return 1; }', [])).resolves.toBe('ok');
    expect(worker.dataReads.count).toBe(2);
    executor.dispose();
  });
});
