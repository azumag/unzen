/**
 * Chrome Prompt API adapter (issue #95).
 *
 * The ChromeLanguageModelBackend must run against the real browser global
 * `window.ai.languageModel` in production, but unit tests must be able to
 * inject a fake API instead of touching real browser globals. This module is
 * the seam between the two:
 *
 *   - the `ChromePromptApiNamespace` / `ChromePromptApiSession` interfaces
 *     describe exactly the surface the backend consumes (availability, create,
 *     prompt, promptStreaming, destroy, context usage, contextoverflow);
 *   - `createChromePromptApiNamespaceAdapter()` feature-detects a duck-typed
 *     browser object (the real `window.ai.languageModel`) and wraps it so the
 *     backend only ever talks to the stable interface.
 *
 * The backend never references `window` directly; a test injects a fake
 * namespace that implements `ChromePromptApiNamespace`, and production wraps
 * the real browser global through this adapter.
 */

/** Chrome `LanguageModel.availability()` states (mirrors `ModelDownloadState`). */
export type ChromeLanguageModelAvailability =
  | 'unavailable'
  | 'downloadable'
  | 'downloading'
  | 'available';

/** A `downloadprogress` event emitted by the create() monitor API. */
export interface ChromeDownloadProgressEvent {
  readonly loadedTokens: number;
  readonly totalTokens: number;
}

/** Monitor handle handed to the create() `monitor` callback. */
export interface ChromeDownloadMonitor {
  addEventListener(
    type: 'downloadprogress',
    listener: (event: ChromeDownloadProgressEvent) => void,
  ): void;
}

/** A declared expected-input modality/language. */
export interface ChromeExpectedInput {
  readonly type: 'text' | 'image' | 'audio';
  readonly languages?: readonly string[];
}

/** A declared expected-output modality/language (text only per the API). */
export interface ChromeExpectedOutput {
  readonly type: 'text';
  readonly languages?: readonly string[];
}

/** Options forwarded to `LanguageModel.create()` and `availability()`. */
export interface ChromePromptApiCreateOptions {
  readonly signal?: AbortSignal;
  readonly monitor?: (monitor: ChromeDownloadMonitor) => void;
  readonly expectedInputs?: readonly ChromeExpectedInput[];
  readonly expectedOutputs?: readonly ChromeExpectedOutput[];
}

/** The session surface the backend consumes. */
export interface ChromePromptApiSession {
  readonly contextUsage: number;
  readonly contextWindow: { readonly maxTokens: number; readonly tokensLeft: number };
  prompt(input: string, options?: { readonly signal?: AbortSignal }): Promise<string>;
  promptStreaming(
    input: string,
    options?: { readonly signal?: AbortSignal },
  ): ReadableStream<string>;
  addEventListener(type: 'contextoverflow', listener: () => void): void;
  destroy(): void;
}

/** The `LanguageModel` namespace surface the backend consumes. */
export interface ChromePromptApiNamespace {
  availability(options?: ChromePromptApiCreateOptions): Promise<ChromeLanguageModelAvailability>;
  create(options?: ChromePromptApiCreateOptions): Promise<ChromePromptApiSession>;
}

const AVAILABILITY_STATES: readonly string[] = [
  'unavailable',
  'downloadable',
  'downloading',
  'available',
];

/**
 * Feature-detect a duck-typed browser object and wrap it into the stable
 * `ChromePromptApiNamespace` surface. Returns `undefined` when the API is
 * absent or malformed, so the backend can report `unsupported` without ever
 * throwing while probing the environment.
 */
export function createChromePromptApiNamespaceAdapter(
  namespace: unknown,
): ChromePromptApiNamespace | undefined {
  if (!isRecord(namespace)) return undefined;
  if (
    typeof namespace.availability !== 'function' ||
    typeof namespace.create !== 'function'
  ) {
    return undefined;
  }
  const real = namespace as Record<string, unknown>;
  return {
    availability: async (options) => {
      const value = await (real.availability as (opts?: unknown) => unknown)(options);
      // A future Chrome build returning an unknown string must never be trusted
      // as ready; map it to the safe 'unavailable' state.
      return typeof value === 'string' && AVAILABILITY_STATES.includes(value)
        ? (value as ChromeLanguageModelAvailability)
        : 'unavailable';
    },
    create: async (options) => {
      const session = await (real.create as (opts?: unknown) => unknown)(options);
      return wrapSession(session);
    },
  };
}

/**
 * Wrap a duck-typed session object (created by the real browser) into the
 * stable session surface. Missing optional fields degrade gracefully instead of
 * crashing the backend.
 */
function wrapSession(real: unknown): ChromePromptApiSession {
  const session = isRecord(real) ? (real as Record<string, unknown>) : {};
  return {
    get contextUsage() {
      // NaN (not 0) when the runtime does not report usage: the backend's
      // `isFinite && >= 0` check then falls back to `limit - tokensLeft`. A 0
      // would mask a missing metric and make soft/hard context thresholds
      // silently unreachable.
      return typeof session.contextUsage === 'number' ? session.contextUsage : NaN;
    },
    get contextWindow() {
      const window = isRecord(session.contextWindow) ? session.contextWindow : {};
      return {
        maxTokens: typeof window.maxTokens === 'number' ? window.maxTokens : 0,
        tokensLeft: typeof window.tokensLeft === 'number' ? window.tokensLeft : 0,
      };
    },
    prompt: (input, options) => {
      const fn = session.prompt as ((input: string, options?: unknown) => Promise<string>) | undefined;
      if (fn === undefined) return Promise.reject(new Error('session.prompt is not available'));
      return fn(input, options);
    },
    promptStreaming: (input, options) => {
      const fn = session.promptStreaming as
        | ((input: string, options?: unknown) => ReadableStream<string>)
        | undefined;
      if (fn === undefined) return new ReadableStream({ start: (c) => c.error(new Error('session.promptStreaming is not available')) });
      return fn(input, options);
    },
    addEventListener: (type, listener) => {
      const fn = session.addEventListener as
        | ((type: string, listener: unknown) => void)
        | undefined;
      if (fn !== undefined) fn(type, listener);
    },
    destroy: () => {
      const fn = session.destroy as (() => void) | undefined;
      if (fn !== undefined) fn();
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
