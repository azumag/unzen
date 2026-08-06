/**
 * ChromeLanguageModelBackend tests (issue #95).
 *
 * The backend is exercised against the scriptable fake Prompt API
 * (chrome-prompt-api-fake.ts), never against real browser globals. Tests are
 * organized by the issue #95 acceptance criteria:
 *
 *   1. unsupported environments return an unsupported capability without
 *      throwing a scatter of exceptions;
 *   2. model-preparation progress is observable (onPrepare / prepare result);
 *   3. streaming (including Japanese) is delivered as common InferenceEvents;
 *   4. no token/event flows after abort;
 *   5. context usage and overflow are determinable by the caller;
 *   6. reuse after session destroy is rejected;
 *   7. API-specific exceptions map to the common ErrorCode taxonomy;
 *   8. telemetry never carries model download content or prompt text.
 */

import { describe, expect, it } from 'vitest';
import {
  ALLOWED_CHROME_TRANSITIONS,
  ChromeLanguageModelBackend,
  classifyChromeError,
  transitionBackendState,
} from '../src/chrome-language-model-backend.js';
import { ErrorCode, UnzenError } from '../src/errors.js';
import {
  INFERENCE_PROTOCOL_VERSION,
  type InferenceEvent,
  type InferenceRequest,
  type WorkerCapability,
} from '../src/inference-backend.js';
import {
  FakeChromePromptApi,
  abortError,
  invalidArgumentError,
  notAllowedError,
  notSupportedError,
  quotaExceededError,
  sessionDestroyedError,
  type FakeChromePromptApiOptions,
} from './chrome-prompt-api-fake.js';
import {
  createChromePromptApiNamespaceAdapter,
} from '../src/chrome-prompt-api-adapter.js';

function createRequest(overrides: Partial<InferenceRequest> = {}): InferenceRequest {
  return {
    protocolVersion: INFERENCE_PROTOCOL_VERSION,
    requestId: 'req-1',
    input: 'こんにちは世界',
    ...overrides,
  };
}

/** Drain an execute() stream into an event list (the AsyncIterable contract). */
async function collectEvents(
  backend: ChromeLanguageModelBackend,
  request: InferenceRequest,
  signal?: AbortSignal,
): Promise<InferenceEvent[]> {
  const events: InferenceEvent[] = [];
  const controller = new AbortController();
  for await (const event of backend.execute(request, signal ?? controller.signal)) {
    events.push(event);
  }
  return events;
}

async function prepareBackend(options?: {
  session?: FakeChromePromptApiOptions['session'];
}): Promise<{ api: FakeChromePromptApi; backend: ChromeLanguageModelBackend }> {
  const api = new FakeChromePromptApi(options);
  const backend = new ChromeLanguageModelBackend({ namespace: api });
  await backend.prepare();
  return { api, backend };
}

// --- State machine -----------------------------------------------------------

describe('Chrome backend state machine', () => {
  it('allows the documented lifecycle transitions', () => {
    expect(ALLOWED_CHROME_TRANSITIONS.unsupported).toEqual(['destroyed']);
    expect(ALLOWED_CHROME_TRANSITIONS.unavailable).toEqual(['preparing', 'destroyed']);
    expect(ALLOWED_CHROME_TRANSITIONS.preparing).toEqual([
      'ready',
      'failed',
      'unavailable',
      'destroyed',
    ]);
    expect(ALLOWED_CHROME_TRANSITIONS.ready).toEqual(['busy', 'failed', 'destroyed']);
    expect(ALLOWED_CHROME_TRANSITIONS.busy).toEqual(['ready', 'failed', 'destroyed']);
    expect(ALLOWED_CHROME_TRANSITIONS.failed).toEqual(['destroyed']);
    expect(ALLOWED_CHROME_TRANSITIONS.destroyed).toEqual([]);
  });

  it('applies a valid transition', () => {
    const next = transitionBackendState({ phase: 'unavailable' }, { phase: 'preparing', progress: 0 });
    expect(next).toEqual({ phase: 'preparing', progress: 0 });
  });

  it('rejects an illegal transition with StateTransitionError', () => {
    expect(() => transitionBackendState({ phase: 'ready' }, { phase: 'preparing', progress: 0 })).toThrow(
      /illegal Chrome backend transition: ready -> preparing/,
    );
    expect(() => transitionBackendState({ phase: 'failed' }, { phase: 'ready' })).toThrow(
      /illegal Chrome backend transition: failed -> ready/,
    );
    expect(() => transitionBackendState({ phase: 'destroyed' }, { phase: 'ready' })).toThrow(
      /illegal Chrome backend transition: destroyed -> ready/,
    );
  });
});

// --- Error classification ----------------------------------------------------

describe('classifyChromeError (issue #95 acceptance 7)', () => {
  it('passes through structured UnzenError codes', () => {
    const inner = new UnzenError('context full', ErrorCode.ContextOverflow);
    expect(classifyChromeError(inner)).toBe(ErrorCode.ContextOverflow);
  });

  it('maps abort-like errors to UserCancellation', () => {
    expect(classifyChromeError(abortError())).toBe(ErrorCode.UserCancellation);
    const controller = new AbortController();
    controller.abort();
    expect(classifyChromeError(controller.signal)).toBe(ErrorCode.UserCancellation);
  });

  it('maps QuotaExceededError to ContextOverflow', () => {
    expect(classifyChromeError(quotaExceededError())).toBe(ErrorCode.ContextOverflow);
  });

  it('maps activation-rejections to UserActivationRequired, other NotAllowedError to PermissionDenied', () => {
    expect(classifyChromeError(notAllowedError())).toBe(ErrorCode.UserActivationRequired);
    expect(classifyChromeError(notAllowedError('policy denied the operation'))).toBe(
      ErrorCode.PermissionDenied,
    );
  });

  it('maps NotSupportedError to UnsupportedModality', () => {
    expect(classifyChromeError(notSupportedError())).toBe(ErrorCode.UnsupportedModality);
  });

  it('maps NotSupportedError to ModelUnavailable during preparation', () => {
    expect(classifyChromeError(notSupportedError(), 'prepare')).toBe(ErrorCode.ModelUnavailable);
  });

  it('maps InvalidArgumentError / TypeError to InvalidInput', () => {
    expect(classifyChromeError(invalidArgumentError())).toBe(ErrorCode.InvalidInput);
    expect(classifyChromeError(new TypeError('bad prompt'))).toBe(ErrorCode.InvalidInput);
  });

  it('maps InvalidStateError to SessionDestroyed', () => {
    expect(classifyChromeError(sessionDestroyedError())).toBe(ErrorCode.SessionDestroyed);
  });

  it('degrades unknown errors to RuntimeTransient', () => {
    expect(classifyChromeError(new Error('mystery failure'))).toBe(ErrorCode.RuntimeTransient);
    expect(classifyChromeError('string failure')).toBe(ErrorCode.RuntimeTransient);
  });
});

// --- Unsupported environment (acceptance 1) ----------------------------------

describe('unsupported environment (issue #95 acceptance 1)', () => {
  function createUnsupported(): ChromeLanguageModelBackend {
    return new ChromeLanguageModelBackend({ namespace: undefined });
  }

  it('reports an unsupported capability without throwing', async () => {
    const backend = createUnsupported();
    const capability: WorkerCapability = await backend.describeCapabilities();
    expect(capability.backend).toBe('browser-built-in-full-model');
    expect(capability.runtimeName).toBe('chrome-prompt-api');
    expect(capability.modelDownloadState).toBe('unavailable');
    expect(capability.health).toMatchObject({ lastErrorCode: ErrorCode.UnsupportedApi });
  });

  it('prepare() returns unavailable instead of throwing', async () => {
    const result = await createUnsupported().prepare();
    expect(result.state).toBe('unavailable');
    expect(result.detail).toMatch(/not available/);
  });

  it('execute() yields an UnsupportedApi error event', async () => {
    const events = await collectEvents(createUnsupported(), createRequest());
    expect(events).toEqual([
      {
        type: 'error',
        code: ErrorCode.UnsupportedApi,
        message: expect.stringContaining('not available'),
      },
    ]);
  });

  it('starts in the unsupported phase', () => {
    expect(createUnsupported().snapshotState()).toEqual({ phase: 'unsupported' });
  });
});

// --- Prepare lifecycle (acceptance 2) -----------------------------------------

describe('prepare() lifecycle (issue #95 acceptance 2)', () => {
  it('streams download progress and reaches ready', async () => {
    const api = new FakeChromePromptApi({
      downloadSteps: [
        { loadedTokens: 10, totalTokens: 100 },
        { loadedTokens: 55, totalTokens: 100 },
        { loadedTokens: 100, totalTokens: 100 },
      ],
    });
    const backend = new ChromeLanguageModelBackend({ namespace: api });
    const prepares: InferenceEvent[] = [];
    backend.onPrepare((event) => prepares.push(event));

    const result = await backend.prepare();

    expect(result.state).toBe('available');
    expect(prepares).toEqual([
      { type: 'prepare', state: 'downloading', progress: 0.1 },
      { type: 'prepare', state: 'downloading', progress: 0.55 },
      { type: 'prepare', state: 'downloading', progress: 1 },
      { type: 'prepare', state: 'available' },
    ]);
    expect(backend.snapshotState()).toEqual({ phase: 'ready' });
    expect(api.sessions).toHaveLength(1);
  });

  it('passes expected inputs/outputs with the configured languages to create()', async () => {
    const api = new FakeChromePromptApi();
    const backend = new ChromeLanguageModelBackend({
      namespace: api,
      supportedLanguages: ['ja', 'en'],
    });
    await backend.prepare();
    const options = api.createOptionsHistory[0];
    expect(options).toMatchObject({
      expectedInputs: [{ type: 'text', languages: ['ja', 'en'] }],
      expectedOutputs: [{ type: 'text', languages: ['ja', 'en'] }],
    });
  });

  it('reports a concurrent prepare() as still-downloading', async () => {
    const api = new FakeChromePromptApi({ createDelayMs: 30 });
    const backend = new ChromeLanguageModelBackend({ namespace: api });
    const first = backend.prepare();
    const concurrent = await backend.prepare();
    expect(concurrent).toMatchObject({ state: 'downloading' });
    await first;
  });

  it('returns to unavailable on user-activation rejection so a retry is possible', async () => {
    const api = new FakeChromePromptApi({ createError: notAllowedError() });
    const backend = new ChromeLanguageModelBackend({ namespace: api });
    await expect(backend.prepare()).rejects.toMatchObject({
      code: ErrorCode.UserActivationRequired,
    });
    expect(backend.snapshotState()).toEqual({ phase: 'unavailable' });

    // Retry succeeds once the environment permits the download (fake swap).
    api.createError = undefined;
    await expect(backend.prepare()).resolves.toMatchObject({ state: 'available' });
    expect(backend.snapshotState()).toEqual({ phase: 'ready' });
  });

  it('becomes terminally failed on a non-activation create failure', async () => {
    const api = new FakeChromePromptApi({ createError: notSupportedError() });
    const backend = new ChromeLanguageModelBackend({ namespace: api });
    await expect(backend.prepare()).rejects.toMatchObject({ code: ErrorCode.ModelUnavailable });
    expect(backend.snapshotState()).toMatchObject({ phase: 'failed' });
  });

  it('maps a transient create failure to ModelPreparationFailure', async () => {
    const api = new FakeChromePromptApi({ createError: new Error('disk error') });
    const backend = new ChromeLanguageModelBackend({ namespace: api });
    await expect(backend.prepare()).rejects.toMatchObject({ code: ErrorCode.ModelPreparationFailure });
    expect(backend.snapshotState()).toMatchObject({ phase: 'failed' });
  });

  it('maps a NotSupportedError create failure to ModelUnavailable (not UnsupportedModality)', async () => {
    const api = new FakeChromePromptApi({ createError: notSupportedError() });
    const backend = new ChromeLanguageModelBackend({ namespace: api });
    await expect(backend.prepare()).rejects.toMatchObject({ code: ErrorCode.ModelUnavailable });
    expect(backend.snapshotState()).toMatchObject({ phase: 'failed' });
  });

  it('delivers preparation progress through the contract-level onProgress channel', async () => {
    const api = new FakeChromePromptApi({
      downloadSteps: [{ loadedTokens: 50, totalTokens: 100 }],
    });
    const backend = new ChromeLanguageModelBackend({ namespace: api });
    const viaContract: unknown[] = [];
    await backend.prepare({
      onProgress: (event) => {
        viaContract.push(event);
      },
    });
    expect(viaContract).toEqual([
      { type: 'prepare', state: 'downloading', progress: 0.5 },
      { type: 'prepare', state: 'available' },
    ]);
  });

  it('returns to unavailable when aborted mid-prepare', async () => {
    const api = new FakeChromePromptApi({ createDelayMs: 30 });
    const backend = new ChromeLanguageModelBackend({ namespace: api });
    const controller = new AbortController();
    const pending = backend.prepare({ signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: ErrorCode.UserCancellation });
    expect(backend.snapshotState()).toEqual({ phase: 'unavailable' });
  });

  it('releases the session when the backend is disposed during prepare', async () => {
    const api = new FakeChromePromptApi({ createDelayMs: 20 });
    const backend = new ChromeLanguageModelBackend({ namespace: api });
    const pending = backend.prepare();
    await backend.dispose();
    await expect(pending).rejects.toMatchObject({ code: ErrorCode.SessionDestroyed });
    expect(backend.snapshotState()).toEqual({ phase: 'destroyed' });
    // The session created while create() was in flight is released, not leaked.
    expect(api.sessions).toHaveLength(1);
    expect(api.sessions[0].destroyed).toBe(true);
  });

  it('surfaces SessionDestroyed when disposal races a create rejection during prepare', async () => {
    const api = new FakeChromePromptApi({
      createDelayMs: 20,
      createError: new Error('network down'),
    });
    const backend = new ChromeLanguageModelBackend({ namespace: api });
    const pending = backend.prepare();
    await backend.dispose();
    // The rejection races the disposal; it must surface as SessionDestroyed,
    // never as an illegal transition out of the terminal 'destroyed' phase.
    await expect(pending).rejects.toMatchObject({ code: ErrorCode.SessionDestroyed });
    expect(backend.snapshotState()).toEqual({ phase: 'destroyed' });
  });

  it('emits no prepare events after disposal (zombie progress is silenced)', async () => {
    const api = new FakeChromePromptApi({
      createDelayMs: 20,
      downloadSteps: [{ loadedTokens: 50, totalTokens: 100 }],
    });
    const backend = new ChromeLanguageModelBackend({ namespace: api });
    const prepares: InferenceEvent[] = [];
    backend.onPrepare((event) => prepares.push(event));
    const pending = backend.prepare();
    await backend.dispose();
    // The late download progress fired by the browser after pagehide must not
    // reach subscribers; the prepared session is released and the state stays
    // terminal.
    await expect(pending).rejects.toMatchObject({ code: ErrorCode.SessionDestroyed });
    expect(prepares).toEqual([]);
    expect(api.sessions[0].destroyed).toBe(true);
    expect(backend.snapshotState()).toEqual({ phase: 'destroyed' });
  });

  it('throws SessionDestroyed when preparing a disposed backend', async () => {
    const backend = new ChromeLanguageModelBackend({ namespace: new FakeChromePromptApi() });
    await backend.dispose();
    await expect(backend.prepare()).rejects.toMatchObject({ code: ErrorCode.SessionDestroyed });
  });

  it('throws StateTransitionViolation when preparing a busy backend', async () => {
    const api = new FakeChromePromptApi({ session: { streamIntervalMs: 5 } });
    const backend = new ChromeLanguageModelBackend({ namespace: api });
    await backend.prepare();
    const controller = new AbortController();
    const iterator = backend.execute(createRequest({ requiresStreaming: true }), controller.signal)[
      Symbol.asyncIterator
    ]();
    await iterator.next();
    expect(backend.snapshotState().phase).toBe('busy');
    await expect(backend.prepare()).rejects.toMatchObject({ code: ErrorCode.StateTransitionViolation });
    await iterator.return?.(undefined);
  });

  it('ignores an already-aborted signal when already prepared (state gates first)', async () => {
    const api = new FakeChromePromptApi();
    const backend = new ChromeLanguageModelBackend({ namespace: api });
    await backend.prepare();
    const controller = new AbortController();
    controller.abort();
    const result = await backend.prepare({ signal: controller.signal });
    expect(result).toEqual({ state: 'available' });
  });
});

// --- Execution ----------------------------------------------------------------

describe('execute() (issue #95 acceptance 3, 5)', () => {

  it('delivers a completion + context event for a non-streaming request', async () => {
    const { backend } = await prepareBackend();
    const events = await collectEvents(backend, createRequest({ input: 'hello' }));
    expect(events).toEqual([
      {
        type: 'completion',
        requestId: 'req-1',
        output: { tokens: [], text: 'hello world' },
        totalTimeMs: expect.any(Number) as number,
      },
      { type: 'context', usageTokens: 0, limitTokens: 4096 },
    ]);
    expect(backend.snapshotState()).toEqual({ phase: 'ready' });
  });

  it('streams cumulative chunks as deltas and completes (Japanese)', async () => {
    const { backend } = await prepareBackend({
      session: { streamingChunks: ['こん', 'こんにちは', 'こんにちは世界'] },
    });
    const events = await collectEvents(
      backend,
      createRequest({ input: 'こんにちは', requiresStreaming: true }),
    );
    const types = events.map((event) => event.type);
    expect(types).toEqual(['stream', 'stream', 'stream', 'completion', 'context']);
    expect(events.filter((event) => event.type === 'stream')).toEqual([
      { type: 'stream', text: 'こん', done: false },
      { type: 'stream', text: 'にちは', done: false },
      { type: 'stream', text: '世界', done: true },
    ]);
    const completion = events.find((event) => event.type === 'completion');
    expect(completion).toMatchObject({ output: { text: 'こんにちは世界' } });
  });

  it('reuses one session in per-conversation mode', async () => {
    const { api, backend } = await prepareBackend();
    await collectEvents(backend, createRequest());
    await collectEvents(backend, createRequest({ requestId: 'req-2' }));
    expect(api.sessions).toHaveLength(1);
  });

  it('rotates to a fresh session per request in per-request mode', async () => {
    const api = new FakeChromePromptApi();
    const backend = new ChromeLanguageModelBackend({
      namespace: api,
      policy: { mode: 'per-request' },
    });
    await backend.prepare();
    await collectEvents(backend, createRequest());
    await collectEvents(backend, createRequest({ requestId: 'req-2' }));
    expect(api.sessions).toHaveLength(2);
    expect(api.sessions[0].destroyed).toBe(true);
  });

  it('yields an UnsupportedRequest error for an unknown protocol version', async () => {
    const { backend } = await prepareBackend();
    const events = await collectEvents(backend, createRequest({ protocolVersion: '9.9.9' }));
    expect(events).toEqual([
      {
        type: 'error',
        code: ErrorCode.UnsupportedRequest,
        message: expect.stringContaining('unsupported protocol version'),
      },
    ]);
  });

  it('rejects execution before prepare()', async () => {
    const backend = new ChromeLanguageModelBackend({ namespace: new FakeChromePromptApi() });
    const events = await collectEvents(backend, createRequest());
    expect(events).toEqual([
      {
        type: 'error',
        code: ErrorCode.ModelPreparationFailure,
        message: expect.stringContaining("call prepare() first"),
      },
    ]);
  });

  it('rejects concurrent execution with StateTransitionViolation', async () => {
    const { backend } = await prepareBackend({ session: { streamIntervalMs: 5 } });
    const controller = new AbortController();
    const first = backend.execute(createRequest({ requiresStreaming: true }), controller.signal)[
      Symbol.asyncIterator
    ]();
    await first.next();
    const second = await collectEvents(backend, createRequest({ requestId: 'req-2' }));
    expect(second).toEqual([
      {
        type: 'error',
        code: ErrorCode.StateTransitionViolation,
        message: expect.stringContaining('maxConcurrency is 1'),
      },
    ]);
    await first.return?.(undefined);
  });

  it('emits a context event at the soft usage threshold and keeps executing', async () => {
    const { backend } = await prepareBackend({
      session: {
        contextUsage: 3000,
        contextWindow: { maxTokens: 4096, tokensLeft: 1096 },
      },
    });
    const events = await collectEvents(backend, createRequest({ input: 'soft' }));
    expect(events).toEqual([
      {
        type: 'context',
        usageTokens: 3000,
        limitTokens: 4096,
      },
      {
        type: 'completion',
        requestId: 'req-1',
        output: { tokens: [], text: 'hello world' },
        totalTimeMs: expect.any(Number) as number,
      },
      { type: 'context', usageTokens: 3000, limitTokens: 4096 },
    ]);
  });

  it('fails explicitly with ContextOverflow at the hard threshold (never drops input)', async () => {
    const { backend } = await prepareBackend({
      session: {
        contextUsage: 3800,
        contextWindow: { maxTokens: 4096, tokensLeft: 296 },
      },
    });
    const events = await collectEvents(backend, createRequest({ input: 'overflow' }));
    expect(events).toEqual([
      {
        type: 'error',
        code: ErrorCode.ContextOverflow,
        message: expect.stringContaining('exceeds hard threshold'),
      },
    ]);
    // The session is retained and the backend stays usable.
    expect(backend.snapshotState()).toEqual({ phase: 'ready' });
  });

  it('rotates to a fresh session at the hard threshold when policy says so', async () => {
    const api = new FakeChromePromptApi({
      session: {
        contextUsage: 3800,
        contextWindow: { maxTokens: 4096, tokensLeft: 296 },
      },
      onCreate: (session) => {
        // Sessions created after the prepare session (i.e. the rotated one)
        // are fresh: a real browser would report low usage there.
        if (api.sessions.length > 0) session.contextUsageOverride = 0;
      },
    });
    const backend = new ChromeLanguageModelBackend({
      namespace: api,
      policy: { mode: 'per-conversation', onHardThreshold: 'rotate-session' },
    });
    await backend.prepare();
    const events = await collectEvents(backend, createRequest({ input: 'rotate' }));
    // Input is processed in the fresh session: completion, not an error.
    expect(events.map((event) => event.type)).toEqual(['completion', 'context']);
    expect(api.sessions).toHaveLength(2);
    expect(api.sessions[0].destroyed).toBe(true);
  });

  it('surfaces a session-creation failure during hard-threshold rotation', async () => {
    const api = new FakeChromePromptApi({
      session: {
        contextUsage: 3800,
        contextWindow: { maxTokens: 4096, tokensLeft: 296 },
      },
    });
    const backend = new ChromeLanguageModelBackend({
      namespace: api,
      policy: { mode: 'per-conversation', onHardThreshold: 'rotate-session' },
    });
    await backend.prepare();
    api.createError = new Error('download interrupted');
    const events = await collectEvents(backend, createRequest({ input: 'rotate' }));
    expect(events).toEqual([
      { type: 'error', code: ErrorCode.RuntimeTransient, message: 'download interrupted' },
    ]);
    // RuntimeTransient is session-level: the backend is terminally failed.
    expect(backend.snapshotState()).toMatchObject({ phase: 'failed' });
  });

  it('surfaces a create failure on a per-request session rotation', async () => {
    const api = new FakeChromePromptApi();
    const backend = new ChromeLanguageModelBackend({ namespace: api, policy: { mode: 'per-request' } });
    await backend.prepare();
    await collectEvents(backend, createRequest());
    api.createError = new Error('creation failed');
    const events = await collectEvents(backend, createRequest({ requestId: 'req-2' }));
    expect(events).toEqual([
      { type: 'error', code: ErrorCode.RuntimeTransient, message: 'creation failed' },
    ]);
  });

  it('ignores a stale contextoverflow event in per-request mode', async () => {
    const api = new FakeChromePromptApi();
    const backend = new ChromeLanguageModelBackend({ namespace: api, policy: { mode: 'per-request' } });
    await backend.prepare();
    api.sessions[0].triggerContextOverflow();
    const events = await collectEvents(backend, createRequest());
    expect(events.map((event) => event.type)).toEqual(['completion', 'context']);
  });

  it('fails terminally when Chrome fires contextoverflow (history was dropped)', async () => {
    const api = new FakeChromePromptApi();
    const backend = new ChromeLanguageModelBackend({ namespace: api });
    await backend.prepare();
    api.sessions[0].triggerContextOverflow();
    const events = await collectEvents(backend, createRequest({ input: 'after-overflow' }));
    expect(events).toEqual([
      {
        type: 'error',
        code: ErrorCode.ContextOverflow,
        message: expect.stringContaining('dropped conversation history'),
      },
    ]);
    expect(api.sessions[0].destroyed).toBe(true);
    expect(backend.snapshotState()).toMatchObject({ phase: 'failed' });
  });
});

// --- Abort (acceptance 4) ------------------------------------------------------

describe('abort handling (issue #95 acceptance 4)', () => {
  it('yields only an abort event when the signal is already aborted', async () => {
    const { backend } = await prepareBackend();
    const controller = new AbortController();
    controller.abort('user cancellation');
    const events = await collectEvents(backend, createRequest(), controller.signal);
    expect(events).toEqual([{ type: 'abort', requestId: 'req-1', reason: 'user cancellation' }]);
    expect(backend.snapshotState()).toEqual({ phase: 'ready' });
  });

  it('stops the stream at the abort point; no token/completion flows after', async () => {
    const { backend } = await prepareBackend({ session: { streamIntervalMs: 5 } });
    const controller = new AbortController();
    const iterator = backend.execute(
      createRequest({ requiresStreaming: true }),
      controller.signal,
    )[Symbol.asyncIterator]();
    const first = (await iterator.next()).value as InferenceEvent;
    expect(first).toMatchObject({ type: 'stream' });
    controller.abort();
    const events: InferenceEvent[] = [first];
    while (true) {
      const result = await iterator.next();
      if (result.done) break;
      events.push(result.value);
    }
    const tail = events.slice(1);
    expect(tail).toEqual([{ type: 'abort', requestId: 'req-1', reason: expect.any(String) }]);
    expect(backend.snapshotState()).toEqual({ phase: 'ready' });
  });

  it('converts an abort from the Prompt API into an abort event', async () => {
    const { backend } = await prepareBackend({
      session: { promptError: abortError() },
    });
    const events = await collectEvents(backend, createRequest({ input: 'abort-me' }));
    expect(events).toEqual([{ type: 'abort', requestId: 'req-1', reason: expect.any(String) }]);
  });

  it('aborts without creating a session when the signal is already aborted (per-request)', async () => {
    const api = new FakeChromePromptApi();
    const backend = new ChromeLanguageModelBackend({ namespace: api, policy: { mode: 'per-request' } });
    await backend.prepare();
    const sessionsBefore = api.sessions.length;
    const controller = new AbortController();
    controller.abort();
    const events = await collectEvents(backend, createRequest(), controller.signal);
    expect(events).toEqual([{ type: 'abort', requestId: 'req-1', reason: expect.any(String) }]);
    // A cancelled request must never trigger a session creation (a model
    // download in a real browser).
    expect(api.sessions).toHaveLength(sessionsBefore);
  });

  it('surfaces an abort when the signal aborts mid session-creation', async () => {
    const api = new FakeChromePromptApi({ createDelayMs: 20 });
    const backend = new ChromeLanguageModelBackend({ namespace: api, policy: { mode: 'per-request' } });
    await backend.prepare();
    // Release the prepared session so the next execute() creates a new one.
    await collectEvents(backend, createRequest());
    const controller = new AbortController();
    const eventsPromise = collectEvents(
      backend,
      createRequest({ requestId: 'req-2' }),
      controller.signal,
    );
    setTimeout(() => controller.abort(), 5);
    const events = await eventsPromise;
    // The abort during create() is an abort event, never an error event, and
    // it is not recorded as a worker failure.
    expect(events).toEqual([{ type: 'abort', requestId: 'req-2', reason: expect.any(String) }]);
    expect(backend.telemetry().failures).toBe(0);
  });

  it('does not throw when the backend is disposed mid-stream (AsyncIterable contract)', async () => {
    const api = new FakeChromePromptApi({ session: { streamIntervalMs: 5 } });
    const backend = new ChromeLanguageModelBackend({ namespace: api });
    await backend.prepare();
    const controller = new AbortController();
    const iterator = backend.execute(
      createRequest({ requiresStreaming: true }),
      controller.signal,
    )[Symbol.asyncIterator]();
    const first = (await iterator.next()).value as InferenceEvent;
    expect(first).toMatchObject({ type: 'stream' });
    await backend.dispose();
    // Draining completes without an exception escaping the AsyncIterable, and
    // a disposed backend emits no further events.
    const events: InferenceEvent[] = [];
    while (true) {
      const result = await iterator.next();
      if (result.done) break;
      events.push(result.value);
    }
    expect(events).toEqual([]);
    expect(backend.snapshotState()).toEqual({ phase: 'destroyed' });
  });

  it('silences a session-creation failure when disposal races it during execute', async () => {
    const api = new FakeChromePromptApi({ createDelayMs: 20 });
    const backend = new ChromeLanguageModelBackend({ namespace: api, policy: { mode: 'per-request' } });
    await backend.prepare();
    // Release the prepared session so the next execute() creates a new one.
    await collectEvents(backend, createRequest());
    api.createError = new Error('boom');
    const controller = new AbortController();
    const eventsPromise = collectEvents(
      backend,
      createRequest({ requestId: 'req-2' }),
      controller.signal,
    );
    setTimeout(() => void backend.dispose(), 5);
    const events = await eventsPromise;
    // A disposed backend emits nothing and does not count the failure.
    expect(events).toEqual([]);
    expect(backend.telemetry().failures).toBe(0);
    expect(backend.snapshotState()).toEqual({ phase: 'destroyed' });
  });

  it('releases a session created while execution races a disposal', async () => {
    const api = new FakeChromePromptApi({ createDelayMs: 20 });
    const backend = new ChromeLanguageModelBackend({ namespace: api, policy: { mode: 'per-request' } });
    await backend.prepare();
    await collectEvents(backend, createRequest());
    const controller = new AbortController();
    const eventsPromise = collectEvents(
      backend,
      createRequest({ requestId: 'req-2' }),
      controller.signal,
    );
    setTimeout(() => void backend.dispose(), 5);
    const events = await eventsPromise;
    expect(events).toEqual([]);
    // Two sessions total (prepare + the one created mid-execution) proves the
    // second create actually ran; the session created after the disposal was
    // released by the finally guard, not leaked.
    expect(api.sessions).toHaveLength(2);
    expect(api.sessions.every((session) => session.destroyed)).toBe(true);
    expect(backend.snapshotState()).toEqual({ phase: 'destroyed' });
  });
});

// --- Errors mapped through execute (acceptance 7) ------------------------------

describe('execute() error mapping (issue #95 acceptance 7)', () => {
  it('maps a prompt QuotaExceededError to a ContextOverflow error event', async () => {
    const { backend } = await prepareBackend({ session: { promptError: quotaExceededError() } });
    const events = await collectEvents(backend, createRequest({ input: 'too-much' }));
    expect(events).toEqual([
      { type: 'error', code: ErrorCode.ContextOverflow, message: expect.any(String) },
    ]);
    // Task-level failure: the session is not poisoned.
    expect(backend.snapshotState()).toEqual({ phase: 'ready' });
  });

  it('maps a prompt InvalidStateError to SessionDestroyed and fails the backend', async () => {
    const { backend } = await prepareBackend({ session: { promptError: sessionDestroyedError() } });
    const events = await collectEvents(backend, createRequest({ input: 'gone' }));
    expect(events).toEqual([
      { type: 'error', code: ErrorCode.SessionDestroyed, message: expect.any(String) },
    ]);
    expect(backend.snapshotState()).toMatchObject({ phase: 'failed' });
  });

  it('maps a transient prompt failure to RuntimeTransient and fails the backend', async () => {
    const { backend } = await prepareBackend({ session: { promptError: new Error('boom') } });
    const events = await collectEvents(backend, createRequest({ input: 'boom' }));
    expect(events).toEqual([
      { type: 'error', code: ErrorCode.RuntimeTransient, message: 'boom' },
    ]);
    expect(backend.snapshotState()).toMatchObject({ phase: 'failed' });
  });

  it('maps a streaming failure to an error event', async () => {
    const { backend } = await prepareBackend({
      session: { streamError: quotaExceededError() },
    });
    const events = await collectEvents(
      backend,
      createRequest({ input: 'stream-boom', requiresStreaming: true }),
    );
    expect(events).toEqual([
      { type: 'error', code: ErrorCode.ContextOverflow, message: expect.any(String) },
    ]);
  });
});

// --- Disposal (acceptance 6) ---------------------------------------------------

describe('dispose() (issue #95 acceptance 6)', () => {
  it('destroys the session, detaches the unload listener, and rejects reuse', async () => {
    const api = new FakeChromePromptApi();
    const removed: string[] = [];
    const emitter = {
      addEventListener(_type: string): void {},
      removeEventListener(type: string): void {
        removed.push(type);
      },
    };
    const backend = new ChromeLanguageModelBackend({ namespace: api, unloadEmitter: emitter });
    await backend.prepare();
    const session = api.sessions[0];

    await backend.dispose();

    expect(session.destroyed).toBe(true);
    expect(removed).toEqual(['pagehide']);
    expect(backend.snapshotState()).toEqual({ phase: 'destroyed' });

    // Acceptance 6: reuse after destroy is rejected.
    const events = await collectEvents(backend, createRequest());
    expect(events).toEqual([
      { type: 'error', code: ErrorCode.SessionDestroyed, message: expect.any(String) },
    ]);
    await expect(backend.prepare()).rejects.toMatchObject({ code: ErrorCode.SessionDestroyed });
    // A second dispose is a no-op.
    await expect(backend.dispose()).resolves.toBeUndefined();
  });

  it('destroys the session on the pagehide unload event', async () => {
    const api = new FakeChromePromptApi();
    const listeners: (() => void)[] = [];
    const emitter = {
      addEventListener(_type: string, listener: () => void): void {
        listeners.push(listener);
      },
      removeEventListener(): void {},
    };
    const backend = new ChromeLanguageModelBackend({ namespace: api, unloadEmitter: emitter });
    await backend.prepare();
    listeners.forEach((listener) => listener());
    expect(api.sessions[0].destroyed).toBe(true);
    expect(backend.snapshotState()).toEqual({ phase: 'destroyed' });
  });

  it('does not touch the emitter when none is provided', async () => {
    const backend = new ChromeLanguageModelBackend({ namespace: new FakeChromePromptApi() });
    await backend.prepare();
    await expect(backend.dispose()).resolves.toBeUndefined();
  });
});

// --- Capability + telemetry (acceptance 8) -------------------------------------

describe('capability and telemetry privacy (issue #95 acceptance 8)', () => {
  it('reports an in-browser privacy boundary and no network destinations', async () => {
    const { backend } = await prepareBackend();
    const capability = await backend.describeCapabilities();
    expect(capability.privacyBoundary).toBe('in-browser');
    expect(capability.allowedNetworkDestinations).toEqual(['none']);
    expect(capability.health).toMatchObject({ recentFailureRate: 0 });
  });

  it('exposes context usage once a session exists', async () => {
    const { backend } = await prepareBackend({
      session: { contextUsage: 1200, contextWindow: { maxTokens: 8000, tokensLeft: 6800 } },
    });
    await collectEvents(backend, createRequest({ input: 'usage' }));
    const capability = await backend.describeCapabilities();
    expect(capability.contextWindowTokens).toBe(8000);
    expect(capability.currentContextUsageTokens).toBe(1200);
  });

  it('reports the measured context window after the session is released (per-request steady state)', async () => {
    const api = new FakeChromePromptApi({
      session: { contextWindow: { maxTokens: 8000, tokensLeft: 8000 } },
    });
    const backend = new ChromeLanguageModelBackend({ namespace: api, policy: { mode: 'per-request' } });
    await backend.prepare();
    await collectEvents(backend, createRequest());
    // The per-request session was released; the measured window is remembered.
    expect(api.sessions[0].destroyed).toBe(true);
    const capability = await backend.describeCapabilities();
    expect(capability.contextWindowTokens).toBe(8000);
  });

  it('telemetry exposes only counters and health, never prompt text or download content', async () => {
    const api = new FakeChromePromptApi({
      downloadSteps: [{ loadedTokens: 100, totalTokens: 100 }],
    });
    const backend = new ChromeLanguageModelBackend({ namespace: api });
    backend.onPrepare(() => {});
    await backend.prepare();
    await collectEvents(backend, createRequest({ input: 'super-secret-prompt' }));
    const telemetry = backend.telemetry();
    expect(Object.keys(telemetry)).toEqual(['executions', 'failures', 'health']);
    expect(telemetry.executions).toBe(1);
    expect(telemetry.failures).toBe(0);
    expect(JSON.stringify(telemetry)).not.toContain('super-secret-prompt');
    expect(JSON.stringify(telemetry)).not.toContain('hello world');
    expect(JSON.stringify(telemetry)).not.toContain('loadedTokens');
  });

  it('tracks failures in the health snapshot', async () => {
    const api = new FakeChromePromptApi({ session: { promptError: new Error('boom') } });
    const backend = new ChromeLanguageModelBackend({ namespace: api });
    await backend.prepare();
    await collectEvents(backend, createRequest({ input: 'boom' }));
    const telemetry = backend.telemetry();
    expect(telemetry.failures).toBe(1);
    expect(telemetry.health.lastErrorCode).toBe(ErrorCode.RuntimeTransient);
    expect(telemetry.health.recentFailureRate).toBe(1);
  });

  it('clears the stale lastErrorCode after a successful execution', async () => {
    let firstSession = true;
    const api = new FakeChromePromptApi({
      onCreate: (session) => {
        if (firstSession) {
          // Task-level failure (invalid input): the session survives, so a
          // later success can recover the backend's health snapshot.
          session.promptErrorOverride = invalidArgumentError();
          firstSession = false;
        }
      },
    });
    const backend = new ChromeLanguageModelBackend({ namespace: api, policy: { mode: 'per-request' } });
    await backend.prepare();
    await collectEvents(backend, createRequest({ input: 'invalid' }));
    expect(backend.telemetry().health.lastErrorCode).toBe(ErrorCode.InvalidInput);
    // The next request uses a fresh session and succeeds: the stale failure
    // reason must not be advertised for a healthy backend.
    await collectEvents(backend, createRequest({ requestId: 'req-2' }));
    const telemetry = backend.telemetry();
    expect(telemetry.health.lastErrorCode).toBeUndefined();
    expect(telemetry.health.recentFailureRate).toBe(0.5);
  });

  it('registers in the backend registry and is selectable by capability', async () => {
    const { BackendRegistry } = await import('../src/backend-registry.js');
    const api = new FakeChromePromptApi();
    const backend = new ChromeLanguageModelBackend({ namespace: api });
    const registry = new BackendRegistry();
    await registry.register('chrome-1', backend);
    const candidates = registry.selectCandidates(
      (capability) => capability.backend === 'browser-built-in-full-model',
    );
    expect(candidates).toEqual(['chrome-1']);
    expect(registry.get('chrome-1')).toBe(backend);
  });
});

// --- Adapter (test seam) -------------------------------------------------------

describe('createChromePromptApiNamespaceAdapter', () => {
  it('returns undefined for absent or malformed globals', () => {
    expect(createChromePromptApiNamespaceAdapter(undefined)).toBeUndefined();
    expect(createChromePromptApiNamespaceAdapter(null)).toBeUndefined();
    expect(createChromePromptApiNamespaceAdapter('window.ai')).toBeUndefined();
    expect(createChromePromptApiNamespaceAdapter({ availability: 42 })).toBeUndefined();
  });

  it('wraps a duck-typed namespace and maps unknown availability to unavailable', async () => {
    const adapter = createChromePromptApiNamespaceAdapter({
      availability: async () => 'mystery-state',
      create: async () => ({
        prompt: async () => 'ok',
        promptStreaming: () => new ReadableStream<string>({ start: (c) => c.close() }),
        destroy: () => {},
      }),
    });
    expect(adapter).toBeDefined();
    expect(await adapter!.availability()).toBe('unavailable');
    const session = await adapter!.create();
    expect(await session.prompt('hi')).toBe('ok');
    // Missing usage is NaN (not 0) so the backend falls back to tokensLeft.
    expect(session.contextUsage).toBeNaN();
    expect(session.contextWindow).toEqual({ maxTokens: 0, tokensLeft: 0 });
  });

  it('degrades a session missing optional members without throwing', async () => {
    const adapter = createChromePromptApiNamespaceAdapter({
      availability: async () => 'available',
      create: async () => ({}),
    });
    const session = await adapter!.create();
    await expect(session.prompt('hi')).rejects.toThrow('session.prompt is not available');
    await expect(
      session.promptStreaming('hi').getReader().read(),
    ).rejects.toThrow('session.promptStreaming is not available');
    expect(() => session.destroy()).not.toThrow();
    expect(() => session.addEventListener('contextoverflow', () => {})).not.toThrow();
  });
});
