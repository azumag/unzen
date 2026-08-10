/**
 * MoonBitSandboxExecutor - MoonBit wasm-gc execution via WebAssembly
 *
 * Implements the SandboxExecutor interface for functions compiled to
 * MoonBit wasm-gc modules. The module bytes are fetched from the manifest
 * codeUrl (a .wasm file), instantiated with the MoonBit runtime imports, and
 * the configured export is called with the request arguments.
 *
 * Execution model (Phase 3):
 * - `code` passed to execute() is the wasm URL (MoonBit has no JS source).
 * - The module is fetched and compiled once per URL and cached; instantiation
 *   happens per call (cheap, and keeps state isolated between requests).
 * - Scalar arguments/results are supported (number / boolean / bigint).
 *   Strings, arrays, and objects require JS-GC interop (WebAssembly.JSTag /
 *   JS String Builtins) and are rejected with UnzenRuntimeError.
 * - wasm-gc execution is synchronous and uninterruptible once started, so
 *   cancellation is honored only before the call begins (same cooperative
 *   boundary as the QuickJS timeout model).
 *
 * Security:
 * - The module is fetched from the manifest-controlled codeUrl only.
 * - The instantiation provides ONLY the MoonBit runtime imports (spectest
 *   print_char etc.) — no host globals, no network, no DOM.
 * - `WebAssembly.validate()` rejects malformed modules before instantiation.
 */

import {
  UnzenFunctionError,
  UnzenNetworkError,
  UnzenRuntimeError,
} from '@unzen/shared';
import { raceWithAbort, throwIfAborted } from './abort';
import { isAbortError } from './abort';
import type { ExecuteOptions, SandboxExecutor } from './sandbox-executor';

/** A compiled MoonBit module ready for instantiation. */
export interface PreparedMoonBitModule {
  /** Module URL (also the cache key) */
  url: string;
  /** Compiled WebAssembly module */
  module: WebAssembly.Module;
}

/** A shared in-flight fetch/compile with per-caller waiter tracking. */
interface InflightModuleRequest {
  promise: Promise<PreparedMoonBitModule>;
  /** Aborts the underlying fetch when the last waiter leaves / on dispose */
  controller: AbortController;
  waiters: number;
}

function isInflight(
  entry: PreparedMoonBitModule | InflightModuleRequest,
): entry is InflightModuleRequest {
  return (entry as InflightModuleRequest).controller !== undefined;
}

/** True when the cached entry is no longer the in-flight request (settled). */
function isSettled(
  cache: Map<string, PreparedMoonBitModule | InflightModuleRequest>,
  url: string,
  pending: InflightModuleRequest,
): boolean {
  return cache.get(url) !== pending;
}

/** Default imports required by MoonBit wasm-gc modules (println etc.). */
const DEFAULT_IMPORTS: WebAssembly.Imports = {
  spectest: {
    print_char: () => {},
  },
};

/** Scalar wasm ABI types that can cross the boundary losslessly. */
function isSupportedScalar(value: unknown): boolean {
  return (
    typeof value === 'number'
    || typeof value === 'boolean'
    || typeof value === 'bigint'
  );
}

export interface MoonBitSandboxOptions {
  /** Additional WebAssembly imports (merged over the MoonBit runtime defaults) */
  imports?: WebAssembly.Imports;
}

export class MoonBitSandboxExecutor implements SandboxExecutor {
  private readonly imports: WebAssembly.Imports;
  /** Compiled modules per URL. A settled module is cached directly; while a
   * fetch/compile is in flight the entry carries waiter tracking so the last
   * caller's cancel (or dispose) aborts the underlying work. */
  private readonly moduleCache = new Map<string, PreparedMoonBitModule | InflightModuleRequest>();
  private disposed = false;

  constructor(options: MoonBitSandboxOptions = {}) {
    this.imports = mergeImports(DEFAULT_IMPORTS, options.imports);
  }

  /** The sandbox is stateless — ready immediately. */
  isReady(): boolean {
    return true;
  }

  /**
   * Fetch and compile the wasm module at `code` (a URL).
   *
   * Fetches are deduplicated per URL and cached. The shared fetch/compile
   * promise is NOT bound to any single caller's signal: each caller races it
   * against their own AbortSignal, so cancelling one execution settles only
   * that caller while the shared work continues for the others.
   */
  async prepare(code: string, signal?: AbortSignal): Promise<PreparedMoonBitModule> {
    throwIfAborted(signal);
    if (this.disposed) {
      throw new UnzenRuntimeError('Executor has been disposed. Create a new instance.');
    }

    const cached = this.moduleCache.get(code);
    if (cached && !isInflight(cached)) {
      // Already fetched and compiled: return the settled module.
      throwIfAborted(signal);
      return cached;
    }

    let pending: InflightModuleRequest;
    if (cached) {
      pending = cached;
    } else {
      const controller = new AbortController();
      pending = {
        promise: this.fetchAndCompile(code, controller.signal),
        controller,
        waiters: 0,
      };
      pending.promise.then(
        (module) => {
          // Promote the settled module ONLY if this is still the current
          // in-flight entry and the executor is not disposed. A stale request
          // that finished after the last waiter aborted (or after dispose)
          // must not overwrite a newer retry's cache slot or resurrect the
          // cache after dispose.
          if (!this.disposed && this.moduleCache.get(code) === pending) {
            this.moduleCache.set(code, module);
          }
        },
        () => {
          // On failure, drop the entry so a retry can start fresh.
          if (this.moduleCache.get(code) === pending) {
            this.moduleCache.delete(code);
          }
        },
      ).catch(() => {
        // The shared promise's rejection is surfaced to waiters via
        // raceWithAbort; this trailing catch keeps the internal chain handled
        // (e.g. an abort after the last waiter left, or a dispose).
      });
      this.moduleCache.set(code, pending);
    }
    pending.waiters++;
    try {
      const result = signal ? raceWithAbort(pending.promise, signal) : pending.promise;
      return await result;
    } finally {
      pending.waiters--;
      if (
        pending.waiters === 0
        && this.moduleCache.get(code) === pending
        && !isSettled(this.moduleCache, code, pending)
      ) {
        // The in-flight fetch has no waiters left and has not settled yet:
        // stop it so a cancelled caller does not leave network traffic
        // running. A settled module stays cached (promoted above).
        this.moduleCache.delete(code);
        pending.controller.abort();
      }
    }
  }

  /**
   * Execute a prepared MoonBit module (or a URL string, which is prepared
   * first). Calls the configured export with the request arguments.
   *
   * @param code - PreparedMoonBitModule, or the wasm URL to prepare
   * @param args - Scalar arguments for the export
   * @param options - Per-execution controls (signal, exportName override)
   */
  async execute(
    code: string | PreparedMoonBitModule,
    args: unknown[],
    options?: ExecuteOptions & { exportName?: string },
  ): Promise<unknown> {
    throwIfAborted(options?.signal);
    if (this.disposed) {
      throw new UnzenRuntimeError('Executor has been disposed. Create a new instance.');
    }

    const prepared = typeof code === 'string' ? await this.prepare(code, options?.signal) : code;
    // Re-check after any await: the caller may have aborted during fetch.
    throwIfAborted(options?.signal);

    // Argument validation: only scalars can cross the wasm boundary in this
    // integration (arrays/objects need JS-GC interop). null/undefined/strings
    // are rejected too: wasm i32/f64/f64 parameters would silently coerce
    // them (e.g. null → 0), masking ABI mismatches.
    for (const arg of args) {
      if (!isSupportedScalar(arg)) {
        throw new UnzenRuntimeError(
          `MoonBit sandbox supports number/boolean/bigint arguments only (got ${arg === null ? 'null' : typeof arg})`,
        );
      }
    }

    // Re-check again before the synchronous export call: instantiation below
    // can be slow (wasm compile/instantiate), and a cancel that arrives during
    // it must prevent the export from running at all.
    throwIfAborted(options?.signal);

    let instance: WebAssembly.Instance;
    try {
      instance = await WebAssembly.instantiate(prepared.module, this.imports);
    } catch (error) {
      throw new UnzenRuntimeError(
        `Failed to instantiate MoonBit module: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    // The instantiate await can be slow (wasm compile). A cancel that arrived
    // during it must prevent the export from running at all.
    throwIfAborted(options?.signal);

    const exportName = options?.exportName ?? 'run';
    const target = (instance.exports as Record<string, unknown>)[exportName];
    if (typeof target !== 'function') {
      throw new UnzenFunctionError(
        `MoonBit module does not export "${exportName}"`,
      );
    }

    const result = (target as (...a: unknown[]) => unknown)(...args);
    // Wasm results can be wasm-gc objects (e.g. arrays) that do not map to
    // plain JS values. Reject non-scalar results instead of leaking an
    // opaque wasm handle to the caller.
    if (!isSupportedScalar(result)) {
      throw new UnzenRuntimeError(
        'MoonBit export returned an unsupported (non-scalar) value',
      );
    }
    return result;
  }

  /** Idempotent disposal — releases the module cache. */
  dispose(): void {
    this.disposed = true;
    for (const entry of this.moduleCache.values()) {
      if (isInflight(entry)) {
        entry.controller.abort();
      }
    }
    this.moduleCache.clear();
  }

  private async fetchAndCompile(url: string, signal: AbortSignal): Promise<PreparedMoonBitModule> {
    let response: Response;
    try {
      response = await globalThis.fetch(url, { method: 'GET', signal });
    } catch (error) {
      if (isAbortError(error)) {
        // The shared fetch was aborted because the last waiter left. This is
        // surfaced per-caller via raceWithAbort; here it just ends the work.
        throw new UnzenRuntimeError('MoonBit module fetch aborted');
      }
      throw new UnzenNetworkError(
        `Failed to fetch MoonBit module: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!response.ok) {
      throw new UnzenNetworkError(
        `Failed to fetch MoonBit module: ${response.status} ${response.statusText}`,
      );
    }

    const bytes = await response.arrayBuffer();
    // The shared request may have been aborted (last waiter left / dispose)
    // while the body was streaming. Stop publishing a result for work nobody
    // wants anymore.
    throwIfAborted(signal);
    if (!WebAssembly.validate(bytes)) {
      throw new UnzenRuntimeError('MoonBit module failed WebAssembly validation');
    }
    const compiled = await WebAssembly.compile(bytes);
    throwIfAborted(signal);
    return {
      url,
      module: compiled,
    };
  }
}

/** Merge caller imports over the MoonBit runtime defaults (deep per module). */
function mergeImports(
  base: WebAssembly.Imports,
  extra?: WebAssembly.Imports,
): WebAssembly.Imports {
  if (!extra) return base;
  const merged: WebAssembly.Imports = {};
  for (const [mod, fns] of Object.entries(base)) {
    merged[mod] = { ...fns } as WebAssembly.ModuleImports;
  }
  for (const [mod, fns] of Object.entries(extra)) {
    merged[mod] = { ...(merged[mod] ?? {}), ...fns } as WebAssembly.ModuleImports;
  }
  return merged;
}
