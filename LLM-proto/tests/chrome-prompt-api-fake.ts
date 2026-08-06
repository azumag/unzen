/**
 * Fake Chrome Prompt API (issue #95 test support).
 *
 * Implements `ChromePromptApiNamespace` directly, so unit tests inject a fake
 * instead of touching real browser globals. The fake is scriptable: availability
 * state, create rejection, download progress steps, prompt output / rejection,
 * streaming chunks, context usage, and the `contextoverflow` event can all be
 * configured per test.
 *
 * Streaming mimics Chrome's cumulative-chunk behaviour: each chunk is the full
 * response text so far (the backend computes deltas). A synchronous stream is
 * used unless `streamIntervalMs > 0`, in which case chunks arrive on a timer so
 * tests can abort mid-stream.
 */

import type {
  ChromeDownloadMonitor,
  ChromeLanguageModelAvailability,
  ChromePromptApiCreateOptions,
  ChromePromptApiNamespace,
  ChromePromptApiSession,
} from '../src/chrome-prompt-api-adapter.js';

export interface FakePromptApiSessionOptions {
  readonly promptText?: string;
  readonly streamingChunks?: readonly string[];
  readonly streamIntervalMs?: number;
  readonly contextUsage?: number;
  readonly contextWindow?: { readonly maxTokens: number; readonly tokensLeft: number };
  readonly promptError?: unknown;
  readonly streamError?: unknown;
}

function domError(name: string, message: string): Error {
  return Object.assign(new Error(message), { name });
}

export const abortError = (): Error => domError('AbortError', 'The operation was aborted');

export const notAllowedError = (message?: string): Error =>
  domError(
    'NotAllowedError',
    message ?? 'create() requires a user activation for the first model download',
  );

export const notSupportedError = (): Error =>
  domError('NotSupportedError', 'expected inputs/outputs are not supported by this model');

export const quotaExceededError = (): Error =>
  domError('QuotaExceededError', 'the input exceeds the available context window');

export const invalidArgumentError = (): Error =>
  domError('InvalidArgumentError', 'invalid prompt argument');

export const sessionDestroyedError = (): Error =>
  domError('InvalidStateError', 'the session is destroyed');

export class FakeChromePromptApiSession implements ChromePromptApiSession {
  destroyed = false;
  private readonly overflowListeners: (() => void)[] = [];

  /**
   * Per-session behaviour overrides. They take precedence over the shared
   * options so a test can vary behaviour across sessions created by one fake
   * (e.g. a fresh session after a hard-threshold rotation is not saturated).
   * `undefined` defers to the shared options.
   */
  promptErrorOverride: unknown = undefined;
  streamErrorOverride: unknown = undefined;
  contextUsageOverride: number | undefined = undefined;

  constructor(private readonly options: FakePromptApiSessionOptions = {}) {}

  get contextUsage(): number {
    // NaN (not 0) when unset, mirroring the production adapter: the backend
    // falls back to `limit - tokensLeft` instead of trusting a fabricated 0.
    return this.contextUsageOverride ?? this.options.contextUsage ?? NaN;
  }

  get contextWindow(): { readonly maxTokens: number; readonly tokensLeft: number } {
    return this.options.contextWindow ?? { maxTokens: 4096, tokensLeft: 4096 };
  }

  addEventListener(type: 'contextoverflow', listener: () => void): void {
    if (type === 'contextoverflow') this.overflowListeners.push(listener);
  }

  /** Fire the contextoverflow event, as Chrome does when history is dropped. */
  triggerContextOverflow(): void {
    for (const listener of [...this.overflowListeners]) listener();
  }

  destroy(): void {
    this.destroyed = true;
  }

  async prompt(
    input: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<string> {
    if (this.destroyed) throw sessionDestroyedError();
    if (options?.signal?.aborted) throw abortError();
    const promptError = this.promptErrorOverride !== undefined
      ? this.promptErrorOverride
      : this.options.promptError;
    if (promptError !== undefined) throw promptError;
    return this.options.promptText ?? 'hello world';
  }

  promptStreaming(
    input: string,
    options?: { readonly signal?: AbortSignal },
  ): ReadableStream<string> {
    if (this.destroyed) throw sessionDestroyedError();
    const streamError = this.streamErrorOverride !== undefined
      ? this.streamErrorOverride
      : this.options.streamError;
    if (streamError !== undefined) {
      return new ReadableStream<string>({
        start: (controller) => controller.error(streamError),
      });
    }
    const chunks = [...(this.options.streamingChunks ?? ['hello', 'hello world'])];
    const intervalMs = this.options.streamIntervalMs ?? 0;
    if (intervalMs <= 0) {
      return new ReadableStream<string>({
        start: (controller) => {
          if (options?.signal?.aborted) {
            controller.error(abortError());
            return;
          }
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      });
    }
    return new ReadableStream<string>({
      start: (controller) => {
        let index = 0;
        let settled = false;
        const timer = setInterval(() => {
          if (settled) return;
          if (options?.signal?.aborted) {
            settled = true;
            clearInterval(timer);
            controller.error(abortError());
            return;
          }
          if (index >= chunks.length) {
            settled = true;
            clearInterval(timer);
            controller.close();
            return;
          }
          controller.enqueue(chunks[index]);
          index += 1;
        }, intervalMs);
      },
    });
  }
}

export interface FakeChromePromptApiOptions {
  readonly availability?: ChromeLanguageModelAvailability;
  /** When set, create() rejects with this error. */
  readonly createError?: unknown;
  /** Simulated first-download progress steps fired through the monitor. */
  readonly downloadSteps?: readonly { readonly loadedTokens: number; readonly totalTokens: number }[];
  /** Delay before create() resolves, so tests can abort mid-prepare. */
  readonly createDelayMs?: number;
  readonly session?: FakePromptApiSessionOptions;
  /** Called for every create() so tests can wire per-session behaviour. */
  readonly onCreate?: (session: FakeChromePromptApiSession, options?: ChromePromptApiCreateOptions) => void;
}

export class FakeChromePromptApi implements ChromePromptApiNamespace {
  availabilityValue: ChromeLanguageModelAvailability;
  createError: unknown = undefined;
  downloadSteps: readonly { readonly loadedTokens: number; readonly totalTokens: number }[] = [];
  createDelayMs = 0;
  readonly sessions: FakeChromePromptApiSession[] = [];
  createOptionsHistory: (ChromePromptApiCreateOptions | undefined)[] = [];
  private readonly sessionOptions: FakePromptApiSessionOptions | undefined;
  private readonly onCreate?: (session: FakeChromePromptApiSession, options?: ChromePromptApiCreateOptions) => void;

  constructor(options: FakeChromePromptApiOptions = {}) {
    this.availabilityValue = options.availability ?? 'available';
    this.createError = options.createError;
    this.downloadSteps = options.downloadSteps ?? [];
    this.createDelayMs = options.createDelayMs ?? 0;
    // Session-level options are configured once per fake and applied to every
    // session it creates (fix: they were previously dropped, so per-session
    // config like promptText/contextUsage never took effect).
    this.sessionOptions = options.session;
    this.onCreate = options.onCreate;
  }

  async availability(): Promise<ChromeLanguageModelAvailability> {
    return this.availabilityValue;
  }

  async create(options?: ChromePromptApiCreateOptions): Promise<ChromePromptApiSession> {
    this.createOptionsHistory.push(options);
    if (this.createDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.createDelayMs));
    }
    if (options?.signal?.aborted) throw abortError();
    if (this.createError !== undefined) throw this.createError;
    if (options?.monitor !== undefined) {
      const steps = [...this.downloadSteps];
      const monitor: ChromeDownloadMonitor = {
        addEventListener(type, listener) {
          if (type !== 'downloadprogress') return;
          for (const step of steps) listener(step);
        },
      };
      options.monitor(monitor);
    }
    const session = new FakeChromePromptApiSession(this.sessionOptions);
    this.onCreate?.(session, options);
    this.sessions.push(session);
    return session;
  }
}
