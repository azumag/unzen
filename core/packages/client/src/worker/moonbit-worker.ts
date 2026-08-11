/**
 * MoonBit wasm-gc Web Worker - browser-side execution of MoonBit modules
 *
 * This script runs inside a Web Worker, so a CPU-bound MoonBit export never
 * blocks the page's main thread (the QuickJS path's Layer 1 isolation).
 *
 * Execution model:
 * - The main thread transfers the module BYTES (ArrayBuffer) per execute;
 *   the worker compiles once per URL + content-hash identity (cached) and
 *   instantiates per call so per-execution state stays isolated.
 * - The export is called synchronously and CANNOT be interrupted mid-run.
 *   The main thread enforces timeouts/cancellation by terminating the worker,
 *   so a runaway export can only stall this dedicated worker, never the page.
 *
 * Error classification:
 *   - Compile/instantiate failure → runtime_error (fallback-eligible)
 *   - Missing export / export throw → function_error (no fallback, user bug)
 *   - Invalid scalar/array ABI input → runtime_error (boundary, not user code)
 *
 * String interop:
 * - Modules compiled with `use-js-builtin-string` are compiled here with JS
 *   String Builtins and the imported-string-constants namespace received in
 *   the init message (default `_`). Instantiation then needs only the
 *   spectest/console runtime imports.
 */

import {
  createMoonbitCancelResultMessage,
  createMoonbitExecuteResultMessage,
  createMoonbitInitResultMessage,
  MOONBIT_WORKER_PROTOCOL_VERSION,
  type MoonbitExecuteMessage,
  type MoonbitWorkerMessage,
  type MoonbitWorkerResponse,
} from './moonbit-worker-protocol';
import {
  compileMoonBitModule,
  DEFAULT_MOONBIT_IMPORTED_STRING_CONSTANTS,
  type MoonBitImportedStringConstants,
} from '../moonbit-compile-options';
import {
  marshalMoonBitArguments,
  unmarshalMoonBitResult,
  validateMoonBitArguments,
} from '../moonbit-array-bridge';

/** Worker state — holds the content-identity compiled module cache. */
export interface MoonbitWorkerState {
  /** Compiled modules keyed by main-thread-validated content identity. */
  compiledModules: Map<string, WebAssembly.Module>;
  /** Set by init; optional only for direct handler tests/backward compatibility. */
  importedStringConstants?: MoonBitImportedStringConstants;
}

function postRejectedMessage(
  msg: MoonbitWorkerMessage,
  error: string,
  postMessage: (msg: MoonbitWorkerResponse) => void,
): void {
  if (msg.type === 'init') {
    postMessage(createMoonbitInitResultMessage(false, msg.generationId, error));
  } else if (msg.type === 'execute') {
    postMessage(createMoonbitExecuteResultMessage(
      msg.requestId,
      false,
      msg.generationId,
      undefined,
      error,
      'runtime_error',
    ));
  } else {
    postMessage(createMoonbitCancelResultMessage(
      msg.requestId,
      false,
      msg.generationId,
      error,
    ));
  }
}

/**
 * Handle a MoonBit worker message — core logic extracted for testability.
 *
 * @param event - MessageEvent with MoonbitWorkerMessage data
 * @param state - Mutable worker state (holds compiled module cache)
 * @param postMessage - Function to send responses to the main thread
 */
export async function handleMoonbitWorkerMessage(
  event: { data: MoonbitWorkerMessage },
  state: MoonbitWorkerState,
  postMessage: (msg: MoonbitWorkerResponse) => void,
): Promise<void> {
  const msg = event.data;

  if (!Number.isSafeInteger(msg.generationId) || msg.generationId < 1) {
    postRejectedMessage(
      msg,
      `malformed generationId: ${String(msg.generationId)}`,
      postMessage,
    );
    return;
  }
  if (msg.protocolVersion !== MOONBIT_WORKER_PROTOCOL_VERSION) {
    const error = `protocol version mismatch (got ${String(msg.protocolVersion)}, expected ${MOONBIT_WORKER_PROTOCOL_VERSION})`;
    postRejectedMessage(msg, error, postMessage);
    return;
  }

  if (msg.type === 'init') {
    if (
      msg.importedStringConstants !== null
      && typeof msg.importedStringConstants !== 'string'
    ) {
      postMessage(createMoonbitInitResultMessage(
        false,
        msg.generationId,
        'Invalid importedStringConstants setting',
      ));
      return;
    }
    if (state.importedStringConstants !== msg.importedStringConstants) {
      state.compiledModules.clear();
    }
    state.importedStringConstants = msg.importedStringConstants;
    postMessage(createMoonbitInitResultMessage(true, msg.generationId));
    return;
  }

  if (msg.type === 'cancel') {
    // Best-effort ack. A cancel that arrives while the export is running
    // cannot be processed until the synchronous call returns; the main thread
    // terminates the worker instead of waiting for this ack.
    postMessage(createMoonbitCancelResultMessage(msg.requestId, true, msg.generationId));
    return;
  }

  if (msg.type === 'execute') {
    await handleMoonbitExecute(msg, state, postMessage);
  }
}

/** Compile (cached per URL), instantiate, and call the configured export. */
async function handleMoonbitExecute(
  msg: MoonbitExecuteMessage,
  state: MoonbitWorkerState,
  postMessage: (msg: MoonbitWorkerResponse) => void,
): Promise<void> {
  let module: WebAssembly.Module;
  const cached = msg.cacheable ? state.compiledModules.get(msg.cacheKey) : undefined;
  if (cached) {
    module = cached;
  } else {
    try {
      // Compile with JS String Builtins enabled so MoonBit String parameters
      // and results cross the boundary as real JS strings. The compile
      // options resolve `wasm:js-string` builtins and the configured
      // imported-string-constants namespace, so those imports need no
      // explicit entries at instantiation time.
      module = await compileMoonBitModule(
        msg.wasm,
        state.importedStringConstants === undefined
          ? DEFAULT_MOONBIT_IMPORTED_STRING_CONSTANTS
          : state.importedStringConstants,
      );
      // Only URL-based (cacheable) executions are stored; inline ArrayBuffer
      // executions compile per call and never accumulate in the cache.
      if (msg.cacheable) {
        state.compiledModules.set(msg.cacheKey, module);
      }
    } catch (error) {
      postMessage(createMoonbitExecuteResultMessage(
        msg.requestId,
        false,
        msg.generationId,
        undefined,
        `Failed to compile MoonBit module: ${error instanceof Error ? error.message : String(error)}`,
        'runtime_error',
      ));
      return;
    }
  }

  try {
    validateMoonBitArguments(msg.args, msg.moonbitAbi);
  } catch (error) {
    postMessage(createMoonbitExecuteResultMessage(
      msg.requestId,
      false,
      msg.generationId,
      undefined,
      error instanceof Error ? error.message : String(error),
      'runtime_error',
    ));
    return;
  }

  let instance: WebAssembly.Instance;
  try {
    instance = await WebAssembly.instantiate(module, buildMoonbitImports());
  } catch (error) {
    postMessage(createMoonbitExecuteResultMessage(
      msg.requestId,
      false,
      msg.generationId,
      undefined,
      `Failed to instantiate MoonBit module: ${error instanceof Error ? error.message : String(error)}`,
      'runtime_error',
    ));
    return;
  }

  const target = (instance.exports as Record<string, unknown>)[msg.exportName];
  if (typeof target !== 'function') {
    postMessage(createMoonbitExecuteResultMessage(
      msg.requestId,
      false,
      msg.generationId,
      undefined,
      `MoonBit module does not export "${msg.exportName}"`,
      'function_error',
    ));
    return;
  }

  let marshalledArgs: unknown[];
  try {
    marshalledArgs = marshalMoonBitArguments(instance, msg.args, msg.moonbitAbi);
  } catch (error) {
    postMessage(createMoonbitExecuteResultMessage(
      msg.requestId,
      false,
      msg.generationId,
      undefined,
      error instanceof Error ? error.message : String(error),
      'runtime_error',
    ));
    return;
  }

  let rawResult: unknown;
  try {
    rawResult = (target as (...a: unknown[]) => unknown)(...marshalledArgs);
  } catch (error) {
    postMessage(createMoonbitExecuteResultMessage(
      msg.requestId,
      false,
      msg.generationId,
      undefined,
      `MoonBit function execution failed: ${error instanceof Error ? error.message : String(error)}`,
      'function_error',
    ));
    return;
  }

  try {
    const result = unmarshalMoonBitResult(instance, rawResult, msg.moonbitAbi);
    postMessage(createMoonbitExecuteResultMessage(
      msg.requestId,
      true,
      msg.generationId,
      result,
    ));
  } catch (error) {
    postMessage(createMoonbitExecuteResultMessage(
      msg.requestId,
      false,
      msg.generationId,
      undefined,
      error instanceof Error ? error.message : String(error),
      'runtime_error',
    ));
  }
}

/**
 * Build the WebAssembly import object for a MoonBit wasm-gc module.
 *
 * - `spectest.print_char`: MoonBit println support.
 * - `console.log`: MoonBit's JS-target console output.
 * - `wasm:js-string` builtins and the configured imported string constants
 *   are resolved by compile options, so neither needs explicit imports.
 */
function buildMoonbitImports(): WebAssembly.Imports {
  return {
    spectest: { print_char: () => {} },
    console: { log: () => {} },
  };
}

// ============================================================
// Worker entry point — only activates when running as a real Web Worker
// ============================================================

if (typeof self !== 'undefined' && typeof self.postMessage === 'function') {
  const workerState: MoonbitWorkerState = {
    compiledModules: new Map(),
    importedStringConstants: DEFAULT_MOONBIT_IMPORTED_STRING_CONSTANTS,
  };

  self.onmessage = (event: MessageEvent<MoonbitWorkerMessage>) => {
    // Top-level try/catch so an unexpected error is reported (and the main
    // thread's hard-kill timer settles the request) instead of crashing the
    // worker silently.
    handleMoonbitWorkerMessage(event, workerState, self.postMessage.bind(self))
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        try {
          const msg = event.data;
          if (msg.type === 'execute') {
            self.postMessage(createMoonbitExecuteResultMessage(
              msg.requestId,
              false,
              msg.generationId,
              undefined,
              message,
              'runtime_error',
            ));
          } else {
            self.postMessage(createMoonbitInitResultMessage(false, msg.generationId, message));
          }
        } catch {
          console.error('[unzen-moonbit-worker] Unrecoverable error:', message);
        }
      });
  };
}
