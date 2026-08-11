/**
 * Tests for MoonBitWorkerSandboxExecutor
 *
 * Uses a MockWorker that actually compiles and executes the fibonacci.wasm
 * fixture (Node 24 runs wasm-gc natively), so the full
 * fetch → transfer → compile → instantiate → export path is exercised.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAX_FUNCTION_PAYLOAD_BYTES,
  UnzenCancelledError,
  UnzenDeadlineExceededError,
  UnzenFunctionError,
  UnzenNetworkError,
  UnzenRuntimeError,
} from '@unzen/shared';
import { MoonBitWorkerSandboxExecutor } from '../src/moonbit-worker-sandbox';
import {
  MOONBIT_WORKER_PROTOCOL_VERSION,
  createMoonbitInitMessage,
  createMoonbitExecuteMessage,
  type MoonbitWorkerMessage,
  type MoonbitWorkerResponse,
} from '../src/worker/moonbit-worker-protocol';

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fibonacciBytes = readFileSync(join(fixtureDir, 'fibonacci.wasm'));
const interopBytes = readFileSync(join(fixtureDir, 'interop.wasm'));
const customInteropBytes = readFileSync(join(fixtureDir, 'interop-custom-namespace.wasm'));
const sortBytes = readFileSync(
  join(fixtureDir, '..', '..', '..', 'server', 'tests', 'fixtures', 'sort.wasm'),
);

function hashBytes(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

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

  it('rejects an oversized module response before reading its body', async () => {
    const readBody = vi.fn().mockResolvedValue(new ArrayBuffer(0));
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({
        'Content-Length': String(MAX_FUNCTION_PAYLOAD_BYTES + 1),
      }),
      arrayBuffer: readBody,
    });
    const executor = createExecutor(new MockMoonbitWorker());

    await expect(executor.execute(
      'https://example.com/oversized.wasm',
      [1],
      { exportName: 'fibonacci' },
    )).rejects.toThrow('exceeds');
    expect(readBody).not.toHaveBeenCalled();
    executor.dispose();
  });

  it.each([
    ['empty workerUrl', { workerUrl: '' }, 'workerUrl'],
    ['negative timeout', { workerUrl: '/moonbit-worker.js', timeout: -1 }, 'timeout'],
    ['non-finite init timeout', { workerUrl: '/moonbit-worker.js', initTimeoutMs: NaN }, 'initTimeoutMs'],
    ['fractional queue size', { workerUrl: '/moonbit-worker.js', maxQueueSize: 1.5 }, 'maxQueueSize'],
    ['non-positive hard-kill multiplier', { workerUrl: '/moonbit-worker.js', hardKillMultiplier: 0 }, 'hardKillMultiplier'],
    [
      'overflowing hard-kill delay',
      { workerUrl: '/moonbit-worker.js', timeout: 2_147_483_647, hardKillMultiplier: 2 },
      'hard-kill delay',
    ],
    ['non-function worker factory', { workerUrl: '/moonbit-worker.js', createWorker: 'nope' }, 'createWorker'],
  ])('rejects %s during construction', (_label, options, expected) => {
    expect(() => new MoonBitWorkerSandboxExecutor(options as never)).toThrow(expected);
  });

  it('accepts a zero-length queue and a fractional hard-kill multiplier', () => {
    const executor = new MoonBitWorkerSandboxExecutor({
      workerUrl: '/moonbit-worker.js',
      timeout: 10,
      maxQueueSize: 0,
      hardKillMultiplier: 0.5,
    });
    expect(executor).toBeDefined();
    executor.dispose();
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

  it('snapshots inline wasm bytes and execution options before worker initialization', async () => {
    const worker = new MockMoonbitWorker();
    let receivedBytes: Uint8Array | undefined;
    let receivedExportName: string | undefined;
    worker.onPostMessage((msg) => {
      if (msg.type === 'init') {
        worker.respond({ type: 'init-result', success: true });
      } else if (msg.type === 'execute') {
        receivedBytes = new Uint8Array(msg.wasm.slice(0));
        receivedExportName = msg.exportName;
        worker.respond({
          type: 'execute-result',
          requestId: msg.requestId,
          success: true,
          value: 55,
        });
      }
    });
    const reads = { signal: 0, exportName: 0, moonbitAbi: 0, expectedHash: 0 };
    const options = {
      get signal() {
        reads.signal += 1;
        if (reads.signal > 1) throw new Error('signal read more than once');
        return undefined;
      },
      get exportName() {
        reads.exportName += 1;
        if (reads.exportName > 1) throw new Error('exportName read more than once');
        return 'fibonacci';
      },
      get moonbitAbi() {
        reads.moonbitAbi += 1;
        if (reads.moonbitAbi > 1) throw new Error('moonbitAbi read more than once');
        return undefined;
      },
      get expectedHash() {
        reads.expectedHash += 1;
        if (reads.expectedHash > 1) throw new Error('expectedHash read more than once');
        return undefined;
      },
    };
    const inline = fibonacciBytes.buffer.slice(
      fibonacciBytes.byteOffset,
      fibonacciBytes.byteOffset + fibonacciBytes.byteLength,
    ) as ArrayBuffer;
    const expectedBytes = new Uint8Array(inline.slice(0));
    const executor = createExecutor(worker);

    const execution = executor.execute(inline, [10], options);
    new Uint8Array(inline).fill(0);

    await expect(execution).resolves.toBe(55);
    expect(receivedBytes).toEqual(expectedBytes);
    expect(receivedExportName).toBe('fibonacci');
    expect(reads).toEqual({ signal: 1, exportName: 1, moonbitAbi: 1, expectedHash: 1 });
    executor.dispose();
  });

  it('rejects invalid execution inputs before fetching or creating a worker', async () => {
    const fetchMock = mockFetchBytes();
    const worker = new MockMoonbitWorker();
    const executor = createExecutor(worker);

    await expect(executor.execute('  ', [], {})).rejects.toThrow(
      'MoonBit module URL must be a non-empty string',
    );
    await expect(executor.execute(
      new Uint8Array([0, 1, 2]) as never,
      [],
    )).rejects.toThrow('MoonBit inline module must be an ArrayBuffer');
    await expect(executor.execute(
      new ArrayBuffer(MAX_FUNCTION_PAYLOAD_BYTES + 1),
      [],
    )).rejects.toThrow(`MoonBit inline module exceeds ${MAX_FUNCTION_PAYLOAD_BYTES} bytes`);
    await expect(executor.execute(
      'https://example.com/fibonacci.wasm',
      [],
      { signal: { aborted: false } } as never,
    )).rejects.toThrow('MoonBit execution signal must be an AbortSignal');
    await expect(executor.prepare(
      'https://example.com/fibonacci.wasm',
      { aborted: false } as never,
    )).rejects.toThrow(UnzenRuntimeError);
    await expect(executor.prepare('')).rejects.toThrow(UnzenRuntimeError);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(worker.terminateCount).toBe(0);
    expect(executor.isReady()).toBe(false);
    executor.dispose();
  });

  it('executes a custom string-constant namespace through worker init', async () => {
    const worker = new MockMoonbitWorker();
    const { handleMoonbitWorkerMessage } = await import('../src/worker/moonbit-worker');
    const state: {
      compiledModules: Map<string, WebAssembly.Module>;
      importedStringConstants?: string | null;
    } = { compiledModules: new Map() };
    let receivedNamespace: string | null | undefined;
    worker.onPostMessage((msg) => {
      if (msg.type === 'init') {
        receivedNamespace = msg.importedStringConstants;
      }
      void handleMoonbitWorkerMessage({ data: msg }, state, (resp) => worker.respond(resp));
    });
    const executor = createExecutor(worker, {
      importedStringConstants: 'unzen:strings',
    });

    await expect(executor.execute(
      customInteropBytes.buffer.slice(
        customInteropBytes.byteOffset,
        customInteropBytes.byteOffset + customInteropBytes.byteLength,
      ) as ArrayBuffer,
      [],
      { exportName: 'weird_string' },
    )).resolves.toBe('__proto__');
    expect(receivedNamespace).toBe('unzen:strings');
    executor.dispose();
  });

  it('executes with imported string constants disabled through worker init', async () => {
    const worker = new MockMoonbitWorker();
    const { handleMoonbitWorkerMessage } = await import('../src/worker/moonbit-worker');
    const state: {
      compiledModules: Map<string, WebAssembly.Module>;
      importedStringConstants?: string | null;
    } = { compiledModules: new Map() };
    worker.onPostMessage((msg) => {
      void handleMoonbitWorkerMessage({ data: msg }, state, (resp) => worker.respond(resp));
    });
    const executor = createExecutor(worker, { importedStringConstants: null });

    await expect(executor.execute(
      fibonacciBytes.buffer.slice(
        fibonacciBytes.byteOffset,
        fibonacciBytes.byteOffset + fibonacciBytes.byteLength,
      ) as ArrayBuffer,
      [10],
      { exportName: 'fibonacci' },
    )).resolves.toBe(55);
    expect(state.importedStringConstants).toBeNull();
    executor.dispose();
  });

  it('validates worker init settings and clears cache only when they change', async () => {
    const { handleMoonbitWorkerMessage } = await import('../src/worker/moonbit-worker');
    const compiled = await WebAssembly.compile(fibonacciBytes);
    const state = {
      compiledModules: new Map<string, WebAssembly.Module>([['fib.wasm', compiled]]),
      importedStringConstants: '_' as string | null,
    };
    const responses: MoonbitWorkerResponse[] = [];

    await handleMoonbitWorkerMessage(
      { data: createMoonbitInitMessage(1, 'unzen:strings') },
      state,
      (response) => responses.push(response),
    );
    expect(state.importedStringConstants).toBe('unzen:strings');
    expect(state.compiledModules.size).toBe(0);
    expect(responses.at(-1)).toMatchObject({ type: 'init-result', success: true });

    state.compiledModules.set('fib.wasm', compiled);
    await handleMoonbitWorkerMessage(
      { data: createMoonbitInitMessage(2, 'unzen:strings') },
      state,
      (response) => responses.push(response),
    );
    expect(state.compiledModules.size).toBe(1);

    const invalid = {
      ...createMoonbitInitMessage(3),
      importedStringConstants: 42,
    } as unknown as MoonbitWorkerMessage;
    await handleMoonbitWorkerMessage(
      { data: invalid },
      state,
      (response) => responses.push(response),
    );
    expect(state.importedStringConstants).toBe('unzen:strings');
    expect(state.compiledModules.size).toBe(1);
    expect(responses.at(-1)).toMatchObject({
      type: 'init-result',
      success: false,
      error: 'Invalid importedStringConstants setting',
    });
  });

  it('rejects mismatched worker protocol messages before mutating or executing', async () => {
    const { handleMoonbitWorkerMessage } = await import('../src/worker/moonbit-worker');
    const compiled = await WebAssembly.compile(fibonacciBytes);
    const state = {
      compiledModules: new Map<string, WebAssembly.Module>([['fib.wasm', compiled]]),
      importedStringConstants: '_' as string | null,
    };
    const responses: MoonbitWorkerResponse[] = [];
    const init = {
      ...createMoonbitInitMessage(1, 'unzen:strings'),
      protocolVersion: MOONBIT_WORKER_PROTOCOL_VERSION + 1,
    };

    await handleMoonbitWorkerMessage(
      { data: init as never },
      state,
      (response) => responses.push(response),
    );
    expect(state.importedStringConstants).toBe('_');
    expect(state.compiledModules.size).toBe(1);
    expect(responses.at(-1)).toMatchObject({
      type: 'init-result',
      success: false,
      error: expect.stringContaining('protocol version mismatch'),
    });

    const execute = {
      ...createMoonbitExecuteMessage(
        'req-version',
        'fib.wasm',
        fibonacciBytes.buffer.slice(
          fibonacciBytes.byteOffset,
          fibonacciBytes.byteOffset + fibonacciBytes.byteLength,
        ) as ArrayBuffer,
        true,
        'fibonacci',
        [10],
        1,
      ),
      protocolVersion: MOONBIT_WORKER_PROTOCOL_VERSION + 1,
    };
    await handleMoonbitWorkerMessage(
      { data: execute as never },
      state,
      (response) => responses.push(response),
    );
    expect(responses.at(-1)).toMatchObject({
      type: 'execute-result',
      requestId: 'req-version',
      success: false,
      errorType: 'runtime_error',
      error: expect.stringContaining('protocol version mismatch'),
    });

    const invalidGeneration = {
      ...createMoonbitExecuteMessage(
        'req-generation',
        'fib.wasm',
        new ArrayBuffer(0),
        true,
        'fibonacci',
        [10],
        1,
      ),
      generationId: -1,
    };
    await handleMoonbitWorkerMessage(
      { data: invalidGeneration as never },
      state,
      (response) => responses.push(response),
    );
    expect(responses.at(-1)).toMatchObject({
      type: 'execute-result',
      requestId: 'req-generation',
      success: false,
      errorType: 'runtime_error',
      error: expect.stringContaining('generationId'),
    });
  });

  it('keeps verified cached bytes isolated from caller mutation', async () => {
    const fetchMock = mockFetchBytes();
    const executor = createExecutor(createRealWorker());
    const expectedHash = hashBytes(fibonacciBytes);

    const first = await executor.prepare(
      'https://example.com/fibonacci.wasm',
      undefined,
      expectedHash,
    );
    new Uint8Array(first)[0] = 0;
    const second = await executor.prepare(
      'https://example.com/fibonacci.wasm',
      undefined,
      expectedHash,
    );
    expect(second).not.toBe(first);
    expect(new Uint8Array(second)).toEqual(new Uint8Array(fibonacciBytes));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    expect(await executor.execute(
      'https://example.com/fibonacci.wasm',
      [15],
      { exportName: 'fibonacci', expectedHash },
    )).toBe(610);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    executor.dispose();
  });

  it('rejects a module hash mismatch without caching unverified bytes', async () => {
    const fetchMock = mockFetchBytes();
    const executor = createExecutor(createRealWorker());
    const url = 'https://example.com/fibonacci.wasm';

    await expect(executor.prepare(url, undefined, hashBytes(new Uint8Array([1]))))
      .rejects.toThrow(UnzenNetworkError);
    await expect(executor.prepare(url, undefined, hashBytes(fibonacciBytes)))
      .resolves.toBeInstanceOf(ArrayBuffer);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    executor.dispose();
  });

  it('maps response body read failures to UnzenNetworkError', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => {
        throw new Error('body stream failed');
      },
    }) as unknown as typeof fetch;
    const executor = createExecutor(new MockMoonbitWorker());

    await expect(executor.prepare('https://example.com/broken-body.wasm'))
      .rejects.toThrow(UnzenNetworkError);
    await expect(executor.prepare('https://example.com/broken-body.wasm'))
      .rejects.toThrow('Failed to read MoonBit module: body stream failed');
    expect(executor.isReady()).toBe(false);
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

  it('round-trips MoonBit String arguments/results via JS String Builtins', async () => {
    // The interop.wasm fixture is compiled with use-js-builtin-string and
    // imports `_` string-constant globals. The worker must compile with
    // builtins:['js-string'] and supply those constants for String calls to
    // work (verified on Chromium + Firefox in the browser E2E).
    const worker = new MockMoonbitWorker();
    const { handleMoonbitWorkerMessage } = await import('../src/worker/moonbit-worker');
    const state = { compiledModules: new Map<string, WebAssembly.Module>() };
    worker.onPostMessage((msg) => {
      void handleMoonbitWorkerMessage({ data: msg }, state, (resp) => worker.respond(resp));
    });
    const executor = createExecutor(worker);

    const echo = await executor.execute(
      interopBytes.buffer.slice(
        interopBytes.byteOffset,
        interopBytes.byteOffset + interopBytes.byteLength,
      ) as ArrayBuffer,
      ['hello'],
      { exportName: 'echo' },
    );
    expect(echo).toBe('hello');

    const joined = await executor.execute(
      interopBytes.buffer.slice(
        interopBytes.byteOffset,
        interopBytes.byteOffset + interopBytes.byteLength,
      ) as ArrayBuffer,
      ['foo', 'bar'],
      { exportName: 'join_words' },
    );
    expect(joined).toBe('foobar');

    const len = await executor.execute(
      interopBytes.buffer.slice(
        interopBytes.byteOffset,
        interopBytes.byteOffset + interopBytes.byteLength,
      ) as ArrayBuffer,
      ['hello'],
      { exportName: 'string_len' },
    );
    expect(len).toBe(5);
    executor.dispose();
  });

  it('reports a stable runtime error when worker compile options are silently ignored', async () => {
    const worker = new MockMoonbitWorker();
    const { handleMoonbitWorkerMessage } = await import('../src/worker/moonbit-worker');
    const state = { compiledModules: new Map<string, WebAssembly.Module>() };
    worker.onPostMessage((msg) => {
      void handleMoonbitWorkerMessage({ data: msg }, state, (resp) => worker.respond(resp));
    });
    const executor = createExecutor(worker);
    const originalCompile = WebAssembly.compile;
    (WebAssembly as unknown as { compile: typeof WebAssembly.compile }).compile = (
      bytes: BufferSource,
    ) => originalCompile(bytes);

    try {
      const error = await executor.execute(
        interopBytes.buffer.slice(
          interopBytes.byteOffset,
          interopBytes.byteOffset + interopBytes.byteLength,
        ) as ArrayBuffer,
        ['hello'],
        { exportName: 'echo' },
      ).catch((reason) => reason);
      expect(error).toBeInstanceOf(UnzenRuntimeError);
      if (!(error instanceof Error)) throw new Error('Expected an Error');
      expect(error.message).toContain('MoonBit String interop is unsupported by this browser');
    } finally {
      (WebAssembly as unknown as { compile: typeof WebAssembly.compile }).compile = originalCompile;
      executor.dispose();
    }
  });

  it('copies i32[] and f64[] through the real worker bridge', async () => {
    const worker = new MockMoonbitWorker();
    const { handleMoonbitWorkerMessage } = await import('../src/worker/moonbit-worker');
    const state = { compiledModules: new Map<string, WebAssembly.Module>() };
    worker.onPostMessage((msg) => {
      void handleMoonbitWorkerMessage({ data: msg }, state, (resp) => worker.respond(resp));
    });
    const executor = createExecutor(worker);
    const bytes = () => interopBytes.buffer.slice(
      interopBytes.byteOffset,
      interopBytes.byteOffset + interopBytes.byteLength,
    ) as ArrayBuffer;

    await expect(executor.execute(bytes(), [[7, -2, 5]], {
      exportName: 'sum_array',
      moonbitAbi: { params: ['i32[]'] },
    })).resolves.toBe(10);
    await expect(executor.execute(bytes(), [[7, -2, 5]], {
      exportName: 'reverse_array',
      moonbitAbi: { params: ['i32[]'], result: 'i32[]' },
    })).resolves.toEqual([5, -2, 7]);
    await expect(executor.execute(bytes(), [[1.5, -2.25, 4], 2], {
      exportName: 'scale_double_array',
      moonbitAbi: { params: ['f64[]', 'scalar'], result: 'f64[]' },
    })).resolves.toEqual([3, -4.5, 8]);
    executor.dispose();
  });

  it('round-trips special String literals (__proto__, empty, Unicode)', async () => {
    // Compile-time importedStringConstants resolve `_` string-constant
    // imports without touching JS object prototypes, so even "__proto__"
    // round-trips losslessly (the manual import-map approach would have
    // triggered the Object.prototype setter).
    const worker = new MockMoonbitWorker();
    const { handleMoonbitWorkerMessage } = await import('../src/worker/moonbit-worker');
    const state = { compiledModules: new Map<string, WebAssembly.Module>() };
    worker.onPostMessage((msg) => {
      void handleMoonbitWorkerMessage({ data: msg }, state, (resp) => worker.respond(resp));
    });
    const executor = createExecutor(worker);
    const run = (exportName: string) => executor.execute(
      interopBytes.buffer.slice(
        interopBytes.byteOffset,
        interopBytes.byteOffset + interopBytes.byteLength,
      ) as ArrayBuffer,
      [],
      { exportName },
    );

    expect(await run('weird_string')).toBe('__proto__');
    expect(await run('empty_string')).toBe('');
    expect(await run('unicode_string')).toBe('こんにちは');
    executor.dispose();
  });

  it('rejects plain JS array arguments when ABI metadata is omitted', async () => {
    const worker = new MockMoonbitWorker();
    const { handleMoonbitWorkerMessage } = await import('../src/worker/moonbit-worker');
    const state = { compiledModules: new Map<string, WebAssembly.Module>() };
    worker.onPostMessage((msg) => {
      void handleMoonbitWorkerMessage({ data: msg }, state, (resp) => worker.respond(resp));
    });
    const executor = createExecutor(worker);

    await expect(
      executor.execute(
        interopBytes.buffer.slice(
          interopBytes.byteOffset,
          interopBytes.byteOffset + interopBytes.byteLength,
        ) as ArrayBuffer,
        [[1, 2, 3]],
        { exportName: 'sum_array' },
      ),
    ).rejects.toThrow('arrays and objects cannot cross');
    executor.dispose();
  });

  it('classifies non-scalar arguments by type (null/undefined/object)', async () => {
    const worker = new MockMoonbitWorker();
    const { handleMoonbitWorkerMessage } = await import('../src/worker/moonbit-worker');
    const state = { compiledModules: new Map<string, WebAssembly.Module>() };
    worker.onPostMessage((msg) => {
      void handleMoonbitWorkerMessage({ data: msg }, state, (resp) => worker.respond(resp));
    });
    const executor = createExecutor(worker);
    const run = (args: unknown[]) => executor.execute(
      fibonacciBytes.buffer.slice(
        fibonacciBytes.byteOffset,
        fibonacciBytes.byteOffset + fibonacciBytes.byteLength,
      ) as ArrayBuffer,
      args,
      { exportName: 'fibonacci' },
    );

    await expect(run([null])).rejects.toThrow('(got null)');
    await expect(run([undefined])).rejects.toThrow('(got undefined)');
    await expect(run([{ n: 10 }])).rejects.toThrow(
      'arrays and objects cannot cross the wasm-gc boundary (got object)',
    );
    executor.dispose();
  });

  it('classifies non-cloneable function/symbol arguments before postMessage', async () => {
    // The main-thread executor must reject these with the same type-specific
    // contract as the worker, BEFORE the DataCloneError path in postMessage.
    mockFetchBytes();
    const executor = createExecutor(createRealWorker());

    await expect(
      executor.execute('https://example.com/fibonacci.wasm', [() => 1], { exportName: 'fibonacci' }),
    ).rejects.toThrow('(got function)');
    await expect(
      executor.execute('https://example.com/fibonacci.wasm', [Symbol('x')], { exportName: 'fibonacci' }),
    ).rejects.toThrow('(got symbol)');
    executor.dispose();
  });

  it('accepts a numeric string for numeric exports via wasm ToNumber (documented)', async () => {
    // The executor validates scalars only; WebAssembly applies its own
    // implicit ToNumber conversion for numeric parameters. This is documented
    // behavior, not a bug: fibonacci("10") === 55.
    const worker = new MockMoonbitWorker();
    const { handleMoonbitWorkerMessage } = await import('../src/worker/moonbit-worker');
    const state = { compiledModules: new Map<string, WebAssembly.Module>() };
    worker.onPostMessage((msg) => {
      void handleMoonbitWorkerMessage({ data: msg }, state, (resp) => worker.respond(resp));
    });
    const executor = createExecutor(worker);

    await expect(executor.execute(
      fibonacciBytes.buffer.slice(
        fibonacciBytes.byteOffset,
        fibonacciBytes.byteOffset + fibonacciBytes.byteLength,
      ) as ArrayBuffer,
      ['10'],
      { exportName: 'fibonacci' },
    )).resolves.toBe(55);
    executor.dispose();
  });

  it('rejects opaque wasm-gc (non-scalar) return values from the worker', async () => {
    const worker = new MockMoonbitWorker();
    const { handleMoonbitWorkerMessage } = await import('../src/worker/moonbit-worker');
    const state = { compiledModules: new Map<string, WebAssembly.Module>() };
    worker.onPostMessage((msg) => {
      void handleMoonbitWorkerMessage({ data: msg }, state, (resp) => worker.respond(resp));
    });
    const executor = createExecutor(worker);

    await expect(executor.execute(
      interopBytes.buffer.slice(
        interopBytes.byteOffset,
        interopBytes.byteOffset + interopBytes.byteLength,
      ) as ArrayBuffer,
      [],
      { exportName: 'make_array' },
    )).rejects.toThrow('unsupported (non-scalar)');
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

    // URL execution caches one module per URL + optional content hash.
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

  it('separates compiled modules when one URL is verified under different hashes', async () => {
    const response = (bytes: Uint8Array) => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer,
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(fibonacciBytes))
      .mockResolvedValueOnce(response(sortBytes));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const worker = new MockMoonbitWorker();
    const { handleMoonbitWorkerMessage } = await import(
      '../src/worker/moonbit-worker'
    );
    const state = { compiledModules: new Map<string, WebAssembly.Module>() };
    worker.onPostMessage((msg) => {
      void handleMoonbitWorkerMessage({ data: msg }, state, (result) => worker.respond(result));
    });
    const executor = createExecutor(worker);
    const url = 'https://example.com/current.wasm';

    await expect(executor.execute(url, [10], {
      exportName: 'fibonacci',
      expectedHash: hashBytes(fibonacciBytes),
    })).resolves.toBe(55);
    await expect(executor.execute(url, [100], {
      exportName: 'sort_benchmark',
      expectedHash: hashBytes(sortBytes),
    })).resolves.toBe(2264);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(state.compiledModules.size).toBe(2);
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
