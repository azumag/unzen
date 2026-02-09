/**
 * Worker Message Protocol
 *
 * Type-safe message definitions for communication between the main thread
 * (WebWorkerSandboxExecutor) and the Web Worker (quickjs-worker.ts).
 *
 * Message flow:
 *   Main Thread → Worker:  InitMessage | ExecuteMessage
 *   Worker → Main Thread:  InitResultMessage | ExecuteResultMessage
 *
 * Design rationale:
 * - Discriminated union via `type` field for safe message routing
 * - requestId on execute messages enables concurrent execution tracking
 * - errorType distinguishes function errors (no fallback) from runtime errors (fallback)
 * - Factory functions ensure consistent message creation
 * - Type guards enable safe narrowing in message handlers
 */

// ============================================================
// Main Thread → Worker Messages
// ============================================================

/** Initialize QuickJS Wasm module in the worker */
export interface InitMessage {
  readonly type: 'init';
}

/** Execute code in the QuickJS sandbox */
export interface ExecuteMessage {
  readonly type: 'execute';
  readonly requestId: string;
  readonly code: string;
  readonly args: unknown[];
  readonly timeout?: number;
}

/** Union of all messages sent from main thread to worker */
export type WorkerMessage = InitMessage | ExecuteMessage;

// ============================================================
// Worker → Main Thread Messages
// ============================================================

/** Result of QuickJS Wasm initialization */
export interface InitResultMessage {
  readonly type: 'init-result';
  readonly success: boolean;
  readonly error?: string;
}

/** Result of code execution (success or error) */
export interface ExecuteResultMessage {
  readonly type: 'execute-result';
  readonly requestId: string;
  readonly success: boolean;
  readonly value?: unknown;
  readonly error?: string;
  /** Distinguishes user code errors from runtime/environment errors.
   * 'function_error' → UnzenFunctionError (no server fallback)
   * 'runtime_error' → UnzenRuntimeError (triggers server fallback) */
  readonly errorType?: 'function_error' | 'runtime_error';
}

/** Union of all messages sent from worker to main thread */
export type WorkerResponse = InitResultMessage | ExecuteResultMessage;

// ============================================================
// Factory Functions
// ============================================================

export function createInitMessage(): InitMessage {
  return { type: 'init' };
}

export function createExecuteMessage(
  requestId: string,
  code: string,
  args: unknown[],
  timeout?: number,
): ExecuteMessage {
  return { type: 'execute', requestId, code, args, timeout };
}

export function createInitResultMessage(
  success: boolean,
  error?: string,
): InitResultMessage {
  return { type: 'init-result', success, error };
}

export function createExecuteResultMessage(
  requestId: string,
  value: unknown,
): ExecuteResultMessage {
  return { type: 'execute-result', requestId, success: true, value };
}

export function createExecuteErrorMessage(
  requestId: string,
  errorType: 'function_error' | 'runtime_error',
  error: string,
): ExecuteResultMessage {
  return { type: 'execute-result', requestId, success: false, error, errorType };
}

// ============================================================
// Type Guards
// ============================================================

export function isInitResultMessage(msg: WorkerResponse): msg is InitResultMessage {
  return msg.type === 'init-result';
}

export function isExecuteResultMessage(msg: WorkerResponse): msg is ExecuteResultMessage {
  return msg.type === 'execute-result';
}
