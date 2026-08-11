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
 * - Scalar arguments/results are supported (number / boolean / bigint /
 *   string). String values cross via the MoonBit JS String Builtins
 *   (`use-js-builtin-string` + `builtins: ['js-string']`). An explicit
 *   MoonBit ABI can additionally copy i32[] / f64[] through standard bridge
 *   exports; arrays without ABI metadata and objects are rejected.
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
  UnzenCancelledError,
  UnzenFunctionError,
  UnzenNetworkError,
  UnzenRuntimeError,
} from '@unzen/shared';
import { raceWithAbort, throwIfAborted } from './abort';
import { isAbortError } from './abort';
import {
  assertUnzenContentIntegrity,
  createUnzenContentCacheKey,
  isValidUnzenContentHash,
} from './content-integrity';
import {
  compileMoonBitModule,
  normalizeMoonBitImportedStringConstants,
  validateMoonBitModule,
  type MoonBitImportedStringConstants,
} from './moonbit-compile-options';
import {
  marshalMoonBitArguments,
  snapshotMoonBitCall,
  unmarshalMoonBitResult,
} from './moonbit-array-bridge';
import {
  normalizeMoonBitModuleUrl,
  snapshotMoonBitAbortSignal,
  snapshotMoonBitExecutionOptions,
} from './moonbit-call';
import type { ExecuteOptions, SandboxExecutor } from './sandbox-executor';

/** A compiled MoonBit module ready for instantiation. */
export interface PreparedMoonBitModule {
  /** Original module URL */
  readonly url: string;
  /** Compiled WebAssembly module */
  readonly module: WebAssembly.Module;
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

/** Keep the mutable wrapper caller-owned while sharing the immutable module. */
function copyPreparedMoonBitModule(prepared: PreparedMoonBitModule): PreparedMoonBitModule {
  return { url: prepared.url, module: prepared.module };
}

/** Default imports required by MoonBit wasm-gc modules (println etc.). */
const DEFAULT_IMPORTS: WebAssembly.Imports = {
  spectest: {
    print_char: () => {},
  },
};

export interface MoonBitSandboxOptions {
  /** Additional WebAssembly imports (merged over the MoonBit runtime defaults) */
  imports?: WebAssembly.Imports;
  /**
   * Namespace configured by MoonBit's `imported-string-constants` option.
   * Defaults to `_`. Use `null` for modules that do not import string
   * constants; String Builtins remain enabled.
   */
  importedStringConstants?: MoonBitImportedStringConstants;
}

export class MoonBitSandboxExecutor implements SandboxExecutor {
  private readonly imports: WebAssembly.Imports;
  private readonly importedStringConstants: MoonBitImportedStringConstants;
  /** Compiled modules per URL + expected hash. A settled module is cached
   * directly; while fetch/compile is in flight the entry carries waiter
   * tracking so the last caller's cancel (or dispose) aborts the work. */
  private readonly moduleCache = new Map<string, PreparedMoonBitModule | InflightModuleRequest>();
  private disposed = false;

  constructor(options: MoonBitSandboxOptions = {}) {
    this.imports = mergeImports(DEFAULT_IMPORTS, options.imports);
    this.importedStringConstants = normalizeMoonBitImportedStringConstants(
      options.importedStringConstants,
    );
  }

  /** The sandbox is stateless — ready immediately. */
  isReady(): boolean {
    return true;
  }

  /**
   * Fetch and compile the wasm module at `code` (a URL).
   *
   * Fetches are deduplicated per URL + expected hash and cached. The shared
   * fetch/compile promise is NOT bound to any single caller's signal: each
   * caller races it against their own AbortSignal, so cancelling one execution
   * settles only that caller while the shared work continues for the others.
   */
  async prepare(
    code: string,
    signal?: AbortSignal,
    expectedHash?: string,
  ): Promise<PreparedMoonBitModule> {
    let signalSnapshot: ReturnType<typeof snapshotMoonBitAbortSignal>;
    try {
      signalSnapshot = snapshotMoonBitAbortSignal(signal);
    } catch (error) {
      throw new UnzenRuntimeError(error instanceof Error ? error.message : String(error));
    }
    if (signalSnapshot.initiallyAborted) {
      throw new UnzenCancelledError('Execution cancelled by caller');
    }
    const requestSignal = signalSnapshot.signal;
    if (this.disposed) {
      throw new UnzenRuntimeError('Executor has been disposed. Create a new instance.');
    }
    let moduleUrl: string;
    try {
      moduleUrl = normalizeMoonBitModuleUrl(code);
    } catch (error) {
      throw new UnzenRuntimeError(error instanceof Error ? error.message : String(error));
    }
    if (expectedHash !== undefined && !isValidUnzenContentHash(expectedHash)) {
      throw new UnzenNetworkError('Invalid MoonBit module hash in manifest');
    }

    const cacheKey = createUnzenContentCacheKey(moduleUrl, expectedHash);
    const cached = this.moduleCache.get(cacheKey);
    if (cached && !isInflight(cached)) {
      // Already fetched and compiled: return the settled module.
      throwIfAborted(requestSignal);
      return copyPreparedMoonBitModule(cached);
    }

    let pending: InflightModuleRequest;
    if (cached) {
      pending = cached;
    } else {
      const controller = new AbortController();
      pending = {
        promise: this.fetchAndCompile(moduleUrl, controller.signal, expectedHash),
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
          if (!this.disposed && this.moduleCache.get(cacheKey) === pending) {
            this.moduleCache.set(cacheKey, module);
          }
        },
        () => {
          // On failure, drop the entry so a retry can start fresh.
          if (this.moduleCache.get(cacheKey) === pending) {
            this.moduleCache.delete(cacheKey);
          }
        },
      ).catch(() => {
        // The shared promise's rejection is surfaced to waiters via
        // raceWithAbort; this trailing catch keeps the internal chain handled
        // (e.g. an abort after the last waiter left, or a dispose).
      });
      this.moduleCache.set(cacheKey, pending);
    }
    pending.waiters++;
    try {
      const result = requestSignal
        ? raceWithAbort(pending.promise, requestSignal)
        : pending.promise;
      return copyPreparedMoonBitModule(await result);
    } finally {
      pending.waiters--;
      if (
        pending.waiters === 0
        && this.moduleCache.get(cacheKey) === pending
        && !isSettled(this.moduleCache, cacheKey, pending)
      ) {
        // The in-flight fetch has no waiters left and has not settled yet:
        // stop it so a cancelled caller does not leave network traffic
        // running. A settled module stays cached (promoted above).
        this.moduleCache.delete(cacheKey);
        pending.controller.abort();
      }
    }
  }

  /**
   * Execute a prepared MoonBit module (or a URL string, which is prepared
   * first). Calls the configured export with the request arguments.
   *
   * @param code - PreparedMoonBitModule, or the wasm URL to prepare
   * @param args - Scalar arguments, plus numeric arrays declared by moonbitAbi
   * @param options - Per-execution controls (signal, exportName, MoonBit ABI)
   */
  async execute(
    code: string | PreparedMoonBitModule,
    args: unknown[],
    options?: ExecuteOptions,
  ): Promise<unknown> {
    let executionOptions: ReturnType<typeof snapshotMoonBitExecutionOptions>;
    try {
      executionOptions = snapshotMoonBitExecutionOptions(options);
    } catch (error) {
      throw new UnzenRuntimeError(error instanceof Error ? error.message : String(error));
    }
    if (executionOptions.signalInitiallyAborted) {
      throw new UnzenCancelledError('Execution cancelled by caller');
    }
    if (this.disposed) {
      throw new UnzenRuntimeError('Executor has been disposed. Create a new instance.');
    }

    let call: ReturnType<typeof snapshotMoonBitCall>;
    try {
      call = snapshotMoonBitCall(args, executionOptions.moonbitAbi);
    } catch (error) {
      throw new UnzenRuntimeError(error instanceof Error ? error.message : String(error));
    }

    let prepared: PreparedMoonBitModule;
    if (typeof code === 'string') {
      let moduleUrl: string;
      try {
        moduleUrl = normalizeMoonBitModuleUrl(code);
      } catch (error) {
        throw new UnzenRuntimeError(error instanceof Error ? error.message : String(error));
      }
      prepared = await this.prepare(
        moduleUrl,
        executionOptions.signal,
        executionOptions.expectedHash,
      );
    } else {
      prepared = code;
    }
    // Re-check after prepare and before instantiation: a cancel during fetch
    // must prevent the module from being instantiated or invoked.
    throwIfAborted(executionOptions.signal);

    let instance: WebAssembly.Instance;
    try {
      // Race instantiation against the caller's signal so a cancel settles
      // the promise immediately instead of waiting for a slow instantiate.
      const instantiate = WebAssembly.instantiate(
        prepared.module,
        buildMoonbitImports(this.imports),
      );
      instance = executionOptions.signal
        ? await raceWithAbort(instantiate, executionOptions.signal)
        : await instantiate;
    } catch (error) {
      if (error instanceof UnzenCancelledError) {
        throw new UnzenCancelledError('Execution was cancelled');
      }
      throw new UnzenRuntimeError(
        `Failed to instantiate MoonBit module: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    // The instantiate await can be slow (wasm compile). A cancel that arrived
    // during it must prevent the export from running at all.
    throwIfAborted(executionOptions.signal);

    const exportName = executionOptions.exportName;
    const target = (instance.exports as Record<string, unknown>)[exportName];
    if (typeof target !== 'function') {
      throw new UnzenFunctionError(
        `MoonBit module does not export "${exportName}"`,
      );
    }

    let marshalledArgs: unknown[];
    try {
      marshalledArgs = marshalMoonBitArguments(instance, call.args, call.abi);
    } catch (error) {
      throw new UnzenRuntimeError(
        error instanceof Error ? error.message : String(error),
      );
    }
    throwIfAborted(executionOptions.signal);

    let result: unknown;
    try {
      result = (target as (...a: unknown[]) => unknown)(...marshalledArgs);
    } catch (error) {
      throw new UnzenFunctionError(
        `MoonBit function execution failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    try {
      return unmarshalMoonBitResult(instance, result, call.abi);
    } catch (error) {
      throw new UnzenRuntimeError(error instanceof Error ? error.message : String(error));
    }
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

  private async fetchAndCompile(
    url: string,
    signal: AbortSignal,
    expectedHash?: string,
  ): Promise<PreparedMoonBitModule> {
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

    let bytes: ArrayBuffer;
    try {
      bytes = await response.arrayBuffer();
    } catch (error) {
      if (isAbortError(error) || signal.aborted) {
        throw new UnzenRuntimeError('MoonBit module fetch aborted');
      }
      throw new UnzenNetworkError(
        `Failed to read MoonBit module: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    // The shared request may have been aborted (last waiter left / dispose)
    // while the body was streaming. Stop publishing a result for work nobody
    // wants anymore.
    throwIfAborted(signal);
    if (expectedHash !== undefined) {
      try {
        await assertUnzenContentIntegrity(bytes, expectedHash);
      } catch (error) {
        throw new UnzenNetworkError(
          error instanceof Error ? error.message : String(error),
        );
      }
      throwIfAborted(signal);
    }
    if (!validateMoonBitModule(bytes, this.importedStringConstants)) {
      throw new UnzenRuntimeError('MoonBit module failed WebAssembly validation');
    }
    // Compile with JS String Builtins enabled so MoonBit String parameters
    // and results cross the boundary as real JS strings. The compile options
    // resolve `wasm:js-string` builtins and the configured string-constant
    // namespace (imported-string-constants), so those imports need no
    // explicit entries at instantiation time.
    let compiled: WebAssembly.Module;
    try {
      compiled = await compileMoonBitModule(bytes, this.importedStringConstants);
    } catch (error) {
      throw new UnzenRuntimeError(
        `Failed to compile MoonBit module: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    throwIfAborted(signal);
    return {
      url,
      module: compiled,
    };
  }
}

/**
 * Build the WebAssembly import object for a MoonBit wasm-gc module.
 *
 * - `spectest.print_char`: MoonBit println support.
 * - `console.log`: MoonBit's JS-target console output.
 * - `wasm:js-string` builtins and the configured imported string constants
 *   are resolved by compile options, so neither needs explicit imports.
 *
 * `base` imports (MoonBit runtime defaults plus caller extras) are preserved;
 * the helper only fills in missing runtime entries. Caller imports under the
 * selected string-constant namespace are preserved in the import object but
 * cannot be used because compile options reserve that namespace.
 */
function buildMoonbitImports(base: WebAssembly.Imports = {}): WebAssembly.Imports {
  const imports: WebAssembly.Imports = mergeImports({}, base);
  if (!imports.spectest) imports.spectest = {};
  if (typeof imports.spectest.print_char !== 'function') {
    imports.spectest.print_char = () => {};
  }
  if (!imports.console) imports.console = {};
  if (typeof imports.console.log !== 'function') {
    imports.console.log = () => {};
  }
  return imports;
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
