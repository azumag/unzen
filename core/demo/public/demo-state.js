/**
 * demo-state.js — pure state machine for a single demo section.
 *
 * This module is intentionally free of DOM / browser APIs so the same code can
 * run in the demo page (imported by demo.js) and in vitest unit tests.
 *
 * The SDK exposes the execution lifecycle as a stream of events
 * (UnzenExecutionEvent, issue #105). The UI must derive its state from those
 * event *types* — never by parsing error/timeout message strings — so this
 * module maps event types to the demo's UI states:
 *
 *   accepted / manifest-fetch-* / code-fetch-*  → preparing
 *   sandbox-initializing                       → initializing-sandbox
 *   browser-execution-started                   → running-in-browser
 *   browser-execution-failed / fallback-started → falling-back-to-server
 *   server-execution-started                    → running-on-server
 *   completed                                   → succeeded
 *   cancel-requested                            → cancelling
 *   cancelled                                   → cancelled
 *   failed                                      → failed
 *
 * The state list itself (idle / validating / preparing / running-in-browser /
 * initializing-sandbox / falling-back-to-server / running-on-server /
 * succeeded / failed / cancelling / cancelled) is mandated by issue #104.
 */

export const DemoState = Object.freeze({
  IDLE: 'idle',
  VALIDATING: 'validating',
  PREPARING: 'preparing',
  INITIALIZING_SANDBOX: 'initializing-sandbox',
  RUNNING_IN_BROWSER: 'running-in-browser',
  FALLING_BACK_TO_SERVER: 'falling-back-to-server',
  RUNNING_ON_SERVER: 'running-on-server',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELLING: 'cancelling',
  CANCELLED: 'cancelled',
});

/**
 * Map an SDK execution event type to the demo UI state it implies.
 * Returns null for unknown event types (caller should ignore the event).
 * This is the ONLY place where SDK event names are translated to UI state.
 */
export function eventToState(eventType) {
  switch (eventType) {
    case 'accepted':
    case 'manifest-fetch-started':
    case 'manifest-fetch-completed':
    case 'code-fetch-started':
    case 'code-fetch-completed':
      return DemoState.PREPARING;
    case 'sandbox-initializing':
      return DemoState.INITIALIZING_SANDBOX;
    case 'browser-execution-started':
      return DemoState.RUNNING_IN_BROWSER;
    // browser-execution-failed arrives just before fallback-started: showing
    // the live "browser failed → falling back" transition is an AC of #104.
    case 'browser-execution-failed':
    case 'fallback-started':
      return DemoState.FALLING_BACK_TO_SERVER;
    case 'server-execution-started':
      return DemoState.RUNNING_ON_SERVER;
    case 'completed':
      return DemoState.SUCCEEDED;
    case 'cancel-requested':
      return DemoState.CANCELLING;
    case 'cancelled':
      return DemoState.CANCELLED;
    case 'failed':
      return DemoState.FAILED;
    default:
      return null;
  }
}

/** Fresh initial state for a demo section. */
export function createDemoState() {
  return {
    state: DemoState.IDLE,
    // Stable error code of the current failure, if any. The demo also uses the
    // synthetic 'input_error' code (validation rejected the inputs before any
    // SDK call); all other codes are SDK ExecutionErrorCode values.
    errorCode: null,
  };
}

/**
 * Reducer over the demo state machine.
 *
 * Actions:
 *   { type: 'SUBMIT' }                       user asked to run (idle/failed/succeeded/cancelled only)
 *   { type: 'VALIDATED' }                    inputs passed validation, SDK call starting
 *   { type: 'VALIDATION_FAILED', errorCode } validation rejected the inputs
 *   { type: 'SDK_EVENT', eventType, errorCode? } an SDK execution event arrived
 *   { type: 'RESET' }                        section reset to idle
 *
 * Unknown/invalid transitions are ignored (return the current state) so a
 * malformed event stream can never crash the UI.
 */
export function reduceDemoState(current, action) {
  switch (action.type) {
    case 'SUBMIT': {
      if (!canSubmit(current.state)) return current;
      return { ...current, state: DemoState.VALIDATING, errorCode: null };
    }
    case 'VALIDATED':
      return { ...current, state: DemoState.PREPARING, errorCode: null };
    case 'VALIDATION_FAILED':
      return { ...current, state: DemoState.FAILED, errorCode: action.errorCode || 'input_error' };
    case 'SDK_EVENT': {
      const target = action.eventType ? eventToState(action.eventType) : null;
      if (target === null) return current;
      return {
        ...current,
        state: target,
        // Remember the SDK error code only when the execution actually failed.
        errorCode:
          action.eventType === 'failed'
            ? action.errorCode || current.errorCode || 'unknown'
            : current.errorCode,
      };
    }
    case 'RESET':
      return createDemoState();
    default:
      return current;
  }
}

/**
 * A run may be started only from a resting state. This is the double-submit
 * guard: while a demo is validating/preparing/running/cancelling the run
 * button stays disabled and a second SUBMIT is ignored.
 */
export function canSubmit(state) {
  switch (state) {
    case DemoState.IDLE:
    case DemoState.SUCCEEDED:
    case DemoState.FAILED:
    case DemoState.CANCELLED:
      return true;
    default:
      return false;
  }
}

/**
 * True while an execution is in flight or being cancelled — the cancel button
 * is offered, the run button stays busy.
 */
export function isRunning(state) {
  switch (state) {
    case DemoState.VALIDATING:
    case DemoState.PREPARING:
    case DemoState.INITIALIZING_SANDBOX:
    case DemoState.RUNNING_IN_BROWSER:
    case DemoState.FALLING_BACK_TO_SERVER:
    case DemoState.RUNNING_ON_SERVER:
    case DemoState.CANCELLING:
      return true;
    default:
      return false;
  }
}

/** True once the run reached a terminal state. */
export function isTerminal(state) {
  return (
    state === DemoState.SUCCEEDED ||
    state === DemoState.FAILED ||
    state === DemoState.CANCELLED
  );
}
