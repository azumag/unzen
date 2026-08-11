/**
 * Tests for MoonBitWorkerSandboxExecutor
 *
 * Uses a MockWorker that actually compiles and executes the fibonacci.wasm
 * fixture (Node 24 runs wasm-gc natively), so the full
 * fetch → transfer → compile → instantiate → export path is exercised.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  UnzenCancelledError,
  UnzenDeadlineExceededError,
  UnzenFunctionError,
  UnzenRuntimeError,
} from '@unzen/shared';
import { MoonBitWorkerSandboxExecutor } from '../src/moonbit-worker-sandbox';
import {
  MOONBIT_WORKER_PROTOCOL_VERSION,
  type MoonbitWorkerMessage,
  type MoonbitWorkerResponse,
} from '../src/worker/moonbit-worker-protocol';

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fibonacciBytes = readFileSync(join(fixtureDir, 'fibonacci.wasm'));
const sortBytes = readFileSync(
  join(fixtureDir, '..', '..', '..', 'server', 'tests', 'fixtures', 'sort.wasm'),
);

/** A response fixture without the envelope — the mock adds version/generation. */
type RespondFixture =
  | { type: 'init-result'; success: boolean; error?: string }
  | {
      type: 'execute-result';
      requestId: string;
      success: boolean;
      value?: unknown;
      error?: string;
      errorType?: 'function_error' | 'runtime_error';
    }
  | { type: 'cancel-result'; requestId: string; success: boolean; error?: string };

/**
 * Mock Worker that simulates the MoonBit worker: it actually compiles the
 * transferred wasm and calls the export, like the real worker script.
 */
class MockMoonbitWorker {
  onmessage: ((event: MessageEvent<MoonbitWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  lastGenerationId = 1;
  private messageHandler: ((msg: MoonbitWorkerMessage) => void) | null = null;
  /** When set, postMessage throws synchronously for matching messages. */
  throwOnPostMessage: ((msg: MoonbitWorkerMessage) => boolean) | null = null;
  /** When set, execute messages are dropped (simulates a hung export). */
  dropExecutes = false;

  onPostMessage(handler: (msg: MoonbitWorkerMessage) => void) {
    this.messageHandler = handler;
  }

  /** Transfer list of the last postMessage (validates zero-copy transfer). */
  lastTransfer: Transferable[] | null = null;
  /** The wasm bytes of the last execute message the mock received. */
  lastReceivedWasm: ArrayBuffer | null = null;
  /** Number of terminate() calls (verifies Worker.terminate enforcement). */
  terminateCount = 0;

  postMessage(msg: MoonbitWorkerMessage, transfer?: Transferable[]) {
    if (this.throwOnPostMessage?.(msg)) {
      throw new Error('DataCloneError: value could not be cloned');
    }
    if (transfer) this.lastTransfer = transfer;
    if (typeof msg.generationId === 'number') {
      this.lastGenerationId = msg.generationId;
    }
    if (msg.type === 'execute') {
      this.lastReceivedWasm = msg.wasm;
    }
    if (this.messageHandler) {
      queueMicrotask(() => this.messageHandler!(msg));
    }
  }

  terminate() {
    this.terminateCount++;
  }

  respond(data: RespondFixture) {
    if (this.onmessage) {
      const full: MoonbitWorkerResponse = {
        protocolVersion: MOONBIT_WORKER_PROTOCOL_VERSION,
        generationId: this.lastGenerationId,
        ...data,
      } as unknown as MoonbitWorkerResponse;
      this.onmessage(new MessageEvent('message', { data: full }));
    }
  }

  simulateError(message = 'Worker crashed') {
    if (this.onerror) {
      this.onerror({ message, type: 'error' } as unknown as ErrorEvent);
    }
  }
}

/** A MockMoonbitWorker wired to actually execute the fixture wasm. */
function createRealWorker() {
  const worker = new MockMoonbitWorker();
  worker.onPostMessage((msg) => {
    if (msg.type === 'init') {
      worker.respond({ type: 'init-result', success: true });
    } else if (msg.type === 'execute') {
      if (worker.dropExecutes) return;
      queueMicrotask(async () => {
        try {
          const module = await WebAssembly.compile(msg.wasm);
          const instance = await WebAssembly.instantiate(module, {
            spectest: { print_char: () => {} },
          });
          const fn = (instance.exports as Record<string, unknown>)[msg.exportName];
          if (typeof fn !== 'function') {
            worker.respond({
              type: 'execute-result',
              requestId: msg.requestId,
              success: false,
              error: `missing export ${msg.exportName}`,
              errorType: 'function_error',
            });
            return;
          }
          const value = (fn as (...a: unknown[]) => unknown)(...msg.args);
          worker.respond({
            type: 'execute-result',
            requestId: msg.requestId,
            success: true,
            value,
          });
        } catch (error) {
          worker.respond({
            type: 'execute-result',
            requestId: msg.requestId,
            success: false,
            error: error instanceof Error ? error.message : String(error),
            errorType: 'runtime_error',
          });
        }
      });
    }
  });
  return worker;
}

function mockFetchBytes(bytes: Uint8Array = fibonacciBytes) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function createExecutor(worker: MockMoonbitWorker, overrides: Record<string, unknown> = {}) {
  return new MoonBitWorkerSandboxExecutor({
    workerUrl: '/moonbit-worker.js',
    createWorker: () => worker as unknown as Worker,
    ...overrides,
  });
}

describe('MoonBitWorkerSandboxExecutor', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('executes a real wasm module through the worker lifecycle (fib(10) = 55)', async () => {
    mockFetchBytes();
    const executor = createExecutor(createRealWorker());

    const result = await executor.execute(
      'https://example.com/fibonacci.wasm',
      [10],
      { exportName: 'fibonacci' },
    );

    expect(result).toBe(55);
    expect(executor.isReady()).toBe(true);
    executor.dispose();
  });

  it('prepares bytes once and reuses the cache across executions', async () => {
    const fetchMock = mockFetchBytes();
    const executor = createExecutor(createRealWorker());

    const first = await executor.prepare('https://example.com/fibonacci.wasm');
    const second = await executor.prepare('https://example.com/fibonacci.wasm');
    expect(first).toBe(second);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    expect(await executor.execute(
      'https://example.com/fibonacci.wasm',
      [15],
      { exportName: 'fibonacci' },
    )).toBe(610);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    executor.dispose();
  });

  it('runs at most one request per generation (single-flight) and drains the queue', async () => {
    mockFetchBytes();
    let inFlight = 0;
    let maxInFlight = 0;
    const worker = new MockMoonbitWorker();
    worker.onPostMessage((msg) => {
      if (msg.type === 'init') {
        worker.respond({ type: 'init-result', success: true });
      } else if (msg.type === 'execute') {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        setTimeout(async () => {
          const module = await WebAssembly.compile(msg.wasm);
          const instance = await WebAssembly.instantiate(module, {
            spectest: { print_char: () => {} },
          });
          const value = (instance.exports as Record<string, unknown>)[msg.exportName] as (...a: unknown[]) => unknown;
          inFlight--;
          worker.respond({
            type: 'execute-result',
            requestId: msg.requestId,
            success: true,
            value: value(...msg.args),
          });
        }, 10);
      }
    });
    const executor = createExecutor(worker);

    const results = await Promise.all([
      executor.execute('https://example.com/fibonacci.wasm', [5], { exportName: 'fibonacci' }),
      executor.execute('https://example.com/fibonacci.wasm', [6], { exportName: 'fibonacci' }),
      executor.execute('https://example.com/fibonacci.wasm', [7], { exportName: 'fibonacci' }),
    ]);

    expect(results).toEqual([5, 8, 13]);
    expect(maxInFlight).toBe(1);
    executor.dispose();
  });

  it('rejects when the bounded queue overflows', async () => {
    mockFetchBytes();
    const worker = createRealWorker();
    worker.dropExecutes = true; // first request keeps running
    const executor = createExecutor(worker, { timeout: 5000, maxQueueSize: 2 });

    const running = executor.execute('https://example.com/fibonacci.wasm', [1], { exportName: 'fibonacci' });
    await new Promise((r) => setTimeout(r, 10));
    const q1 = executor.execute('https://example.com/fibonacci.wasm', [2], { exportName: 'fibonacci' });
    const q2 = executor.execute('https://example.com/fibonacci.wasm', [3], { exportName: 'fibonacci' });
    const overflow = executor.execute('https://example.com/fibonacci.wasm', [4], { exportName: 'fibonacci' });

    await expect(overflow).rejects.toThrow('queue is full');
    expect(executor.diagnostics.queueOverflowCount).toBe(1);

    executor.dispose();
    await expect(running).rejects.toThrow(UnzenRuntimeError);
    await expect(q1).rejects.toThrow(UnzenRuntimeError);
    await expect(q2).rejects.toThrow(UnzenRuntimeError);
  });

  it('settles init waiters when init-result never arrives', async () => {
    mockFetchBytes();
    const worker = new MockMoonbitWorker();
    worker.onPostMessage(() => {
      // drop everything — init hangs
    });
    const executor = createExecutor(worker, { initTimeoutMs: 30 });

    await expect(
      executor.execute('https://example.com/fibonacci.wasm', [1], { exportName: 'fibonacci' }),
    ).rejects.toThrow('initialization timed out');
    expect(executor.diagnostics.initTimeoutCount).toBe(1);
    executor.dispose();
  });

  it('terminates the generation on hard timeout (deadline exceeded)', async () => {
    mockFetchBytes();
    const worker = createRealWorker();
    worker.dropExecutes = true; // export never returns
    const executor = createExecutor(worker, { timeout: 20 });

    await expect(
      executor.execute('https://example.com/fibonacci.wasm', [10], { exportName: 'fibonacci' }),
    ).rejects.toThrow(UnzenDeadlineExceededError);
    // The hung worker was actually terminated, not just abandoned.
    expect(worker.terminateCount).toBe(1);
    expect(executor.diagnostics.forcedTerminationCount).toBe(1);
    expect(executor.diagnostics.generationRestartCount).toBe(0);
    executor.dispose();
  });

  it('cancels a running request by terminating the worker (never fallback)', async () => {
    mockFetchBytes();
    const worker = createRealWorker();
    worker.dropExecutes = true;
    const executor = createExecutor(worker, { timeout: 5000 });

    const controller = new AbortController();
    const p = executor.execute('https://example.com/fibonacci.wasm', [10], {
      exportName: 'fibonacci',
      signal: controller.signal,
    });
    await new Promise((r) => setTimeout(r, 10));
    controller.abort();

    await expect(p).rejects.toThrow(UnzenCancelledError);
    expect(worker.terminateCount).toBe(1);
    expect(executor.diagnostics.cancelCount).toBe(1);
    expect(executor.diagnostics.forcedTerminationCount).toBe(1);
    executor.dispose();
  });

  it('cancels a queued request without touching the running request', async () => {
    mockFetchBytes();
    const worker = createRealWorker();
    worker.dropExecutes = true;
    const executor = createExecutor(worker, { timeout: 5000 });

    const running = executor.execute('https://example.com/fibonacci.wasm', [1], { exportName: 'fibonacci' });
    await new Promise((r) => setTimeout(r, 10));
    const controller = new AbortController();
    const queued = executor.execute('https://example.com/fibonacci.wasm', [2], {
      exportName: 'fibonacci',
      signal: controller.signal,
    });
    await new Promise((r) => setTimeout(r, 10));
    controller.abort();

    await expect(queued).rejects.toThrow(UnzenCancelledError);
    expect(executor.diagnostics.cancelCount).toBe(1);
    executor.dispose();
    await expect(running).rejects.toThrow(UnzenRuntimeError);
  });

  it('rejects immediately for a pre-aborted signal without touching the worker', async () => {
    mockFetchBytes();
    const factory = vi.fn(() => createRealWorker() as unknown as Worker);
    const executor = new MoonBitWorkerSandboxExecutor({
      workerUrl: '/moonbit-worker.js',
      createWorker: factory,
    });
    const controller = new AbortController();
    controller.abort();

    await expect(
      executor.execute('https://example.com/fibonacci.wasm', [1], {
        exportName: 'fibonacci',
        signal: controller.signal,
      }),
    ).rejects.toThrow(UnzenCancelledError);
    expect(factory).not.toHaveBeenCalled();
    executor.dispose();
  });

  it('recovers after a synchronous Worker creation failure', async () => {
    mockFetchBytes();
    let calls = 0;
    const executor = new MoonBitWorkerSandboxExecutor({
      workerUrl: '/moonbit-worker.js',
      createWorker: () => {
        calls++;
        if (calls === 1) throw new Error('SecurityError: Failed to construct Worker');
        return createRealWorker() as unknown as Worker;
      },
    });

    await expect(
      executor.execute('https://example.com/fibonacci.wasm', [10], { exportName: 'fibonacci' }),
    ).rejects.toThrow('Failed to create Worker');

    const result = await executor.execute(
      'https://example.com/fibonacci.wasm',
      [10],
      { exportName: 'fibonacci' },
    );
    expect(result).toBe(55);
    expect(calls).toBe(2);
    executor.dispose();
  });

  it('settles immediately when the execute postMessage throws, then continues', async () => {
    mockFetchBytes();
    const worker = createRealWorker();
    worker.throwOnPostMessage = (msg) => msg.type === 'execute';
    const executor = createExecutor(worker);

    await expect(
      executor.execute('https://example.com/fibonacci.wasm', [10], { exportName: 'fibonacci' }),
    ).rejects.toThrow('Failed to send execute message');

    worker.throwOnPostMessage = null;
    const result = await executor.execute(
      'https://example.com/fibonacci.wasm',
      [10],
      { exportName: 'fibonacci' },
    );
    expect(result).toBe(55);
    executor.dispose();
  });

  it('ignores stale responses from an old generation after a recreate', async () => {
    mockFetchBytes();
    const workers: MockMoonbitWorker[] = [];
    const executor = new MoonBitWorkerSandboxExecutor({
      workerUrl: '/moonbit-worker.js',
      timeout: 20,
      createWorker: () => {
        const w = createRealWorker();
        // First generation hangs → hard timeout kills it; later ones work.
        if (workers.length === 0) w.dropExecutes = true;
        workers.push(w);
        return w as unknown as Worker;
      },
    });

    await expect(
      executor.execute('https://example.com/fibonacci.wasm', [1], { exportName: 'fibonacci' }),
    ).rejects.toThrow(UnzenDeadlineExceededError);
    expect(executor.diagnostics.generationRestartCount).toBe(0);

    // Second generation succeeds.
    const result = await executor.execute(
      'https://example.com/fibonacci.wasm',
      [10],
      { exportName: 'fibonacci' },
    );
    expect(result).toBe(55);
    expect(workers).toHaveLength(2);

    // Feed a stale-generation response through the live worker: ignored.
    const before = executor.diagnostics.lateResponseCount;
    workers[1].lastGenerationId = 1;
    workers[1].respond({
      type: 'execute-result',
      requestId: 'stale-req',
      success: true,
      value: 'stale',
    });
    expect(executor.diagnostics.lateResponseCount).toBe(before + 1);
    executor.dispose();
  });

  it('maps worker function errors to UnzenFunctionError', async () => {
    mockFetchBytes();
    const worker = new MockMoonbitWorker();
    worker.onPostMessage((msg) => {
      if (msg.type === 'init') worker.respond({ type: 'init-result', success: true });
      else if (msg.type === 'execute') {
        worker.respond({
          type: 'execute-result',
          requestId: msg.requestId,
          success: false,
          error: 'missing export nope',
          errorType: 'function_error',
        });
      }
    });
    const executor = createExecutor(worker);

    await expect(
      executor.execute('https://example.com/fibonacci.wasm', [1], { exportName: 'nope' }),
    ).rejects.toThrow(UnzenFunctionError);
    executor.dispose();
  });

  it('maps worker runtime errors to UnzenRuntimeError', async () => {
    mockFetchBytes();
    const worker = new MockMoonbitWorker();
    worker.onPostMessage((msg) => {
      if (msg.type === 'init') worker.respond({ type: 'init-result', success: true });
      else if (msg.type === 'execute') {
        worker.respond({
          type: 'execute-result',
          requestId: msg.requestId,
          success: false,
          error: 'wasm crashed',
          errorType: 'runtime_error',
        });
      }
    });
    const executor = createExecutor(worker);

    await expect(
      executor.execute('https://example.com/fibonacci.wasm', [1], { exportName: 'fibonacci' }),
    ).rejects.toThrow(UnzenRuntimeError);
    executor.dispose();
  });

  it('executes different inline ArrayBuffers against their own bytes', async () => {
    const worker = new MockMoonbitWorker();
    // Use the REAL worker handler so the per-URL compile cache behavior is
    // exactly what ships in the browser bundle.
    const { handleMoonbitWorkerMessage } = await import(
      '../src/worker/moonbit-worker'
    );
    const state = { compiledModules: new Map<string, WebAssembly.Module>() };
    worker.onPostMessage((msg) => {
      void handleMoonbitWorkerMessage({ data: msg }, state, (resp) => worker.respond(resp));
    });
    const executor = createExecutor(worker);

    const fibBytes = fibonacciBytes.buffer.slice(
      fibonacciBytes.byteOffset,
      fibonacciBytes.byteOffset + fibonacciBytes.byteLength,
    ) as ArrayBuffer;
    const sortBuffer = sortBytes.buffer.slice(
      sortBytes.byteOffset,
      sortBytes.byteOffset + sortBytes.byteLength,
    ) as ArrayBuffer;

    const fib = await executor.execute(
      fibBytes,
      [10],
      { exportName: 'fibonacci' },
    );
    const sort = await executor.execute(
      sortBuffer,
      [100],
      { exportName: 'sort_benchmark' },
    );

    expect(fib).toBe(55);
    // Deterministic fixed-seed result for sort(100) with the shared LCG: the
    // sorted array's first element is a stable value, not just "any number".
    expect(sort).toBe(2264);

    // Inline executions must not accumulate in the worker's compile cache.
    expect(state.compiledModules.size).toBe(0);
    executor.dispose();
  });

  it('caches URL-based compiles but not inline compiles', async () => {
    mockFetchBytes();
    const worker = new MockMoonbitWorker();
    const { handleMoonbitWorkerMessage } = await import(
      '../src/worker/moonbit-worker'
    );
    const state = { compiledModules: new Map<string, WebAssembly.Module>() };
    worker.onPostMessage((msg) => {
      void handleMoonbitWorkerMessage({ data: msg }, state, (resp) => worker.respond(resp));
    });
    const executor = createExecutor(worker);

    // URL execution caches one module per URL.
    await executor.execute('https://example.com/fibonacci.wasm', [10], { exportName: 'fibonacci' });
    await executor.execute('https://example.com/fibonacci.wasm', [15], { exportName: 'fibonacci' });
    expect(state.compiledModules.size).toBe(1);

    // Inline executions never touch the cache, even for the same buffer.
    const inline = fibonacciBytes.buffer.slice(
      fibonacciBytes.byteOffset,
      fibonacciBytes.byteOffset + fibonacciBytes.byteLength,
    ) as ArrayBuffer;
    await executor.execute(inline, [10], { exportName: 'fibonacci' });
    await executor.execute(inline, [12], { exportName: 'fibonacci' });
    expect(state.compiledModules.size).toBe(1);
    executor.dispose();
  });

  it('transfers the SAME buffer it sends and keeps the cached original intact', async () => {
    mockFetchBytes();
    const worker = createRealWorker();
    const executor = createExecutor(worker);

    const prepared = await executor.prepare('https://example.com/fibonacci.wasm');
    const result = await executor.execute(
      'https://example.com/fibonacci.wasm',
      [10],
      { exportName: 'fibonacci' },
    );

    expect(result).toBe(55);
    // The transfer list must be the exact buffer the worker received (zero
    // extra copy), and the cached original must not be detached.
    const transfer = worker.lastTransfer?.[0] as ArrayBuffer;
    expect(transfer).toBeDefined();
    expect(worker.lastReceivedWasm).toBe(transfer);
    expect(prepared.byteLength).toBe(fibonacciBytes.byteLength);
    expect(transfer.byteLength).toBe(fibonacciBytes.byteLength);
    executor.dispose();
  });
});
