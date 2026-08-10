/**
 * Unit tests for the demo state machine (public/demo-state.js).
 *
 * The state machine is the core of issue #104's UI requirements:
 * - a running demo cannot be double-submitted (canSubmit guard),
 * - SDK event types map to UI states without parsing message strings,
 * - cancel flows through cancelling → cancelled,
 * - malformed events are ignored instead of crashing the UI.
 */

import { describe, it, expect } from 'vitest';
import {
  DemoState,
  createDemoState,
  reduceDemoState,
  eventToState,
  canSubmit,
  isRunning,
  isTerminal,
} from '../public/demo-state.js';

describe('createDemoState', () => {
  it('starts idle with no error code', () => {
    const state = createDemoState();
    expect(state).toEqual({ state: DemoState.IDLE, errorCode: null });
  });
});

describe('eventToState — SDK events map to UI states (no message parsing)', () => {
  const cases = [
    ['accepted', DemoState.PREPARING],
    ['manifest-fetch-started', DemoState.PREPARING],
    ['manifest-fetch-completed', DemoState.PREPARING],
    ['code-fetch-started', DemoState.PREPARING],
    ['code-fetch-completed', DemoState.PREPARING],
    ['sandbox-initializing', DemoState.INITIALIZING_SANDBOX],
    ['browser-execution-started', DemoState.RUNNING_IN_BROWSER],
    ['browser-execution-failed', DemoState.FALLING_BACK_TO_SERVER],
    ['fallback-started', DemoState.FALLING_BACK_TO_SERVER],
    ['server-execution-started', DemoState.RUNNING_ON_SERVER],
    ['completed', DemoState.SUCCEEDED],
    ['cancel-requested', DemoState.CANCELLING],
    ['cancelled', DemoState.CANCELLED],
    ['failed', DemoState.FAILED],
  ];
  for (const [eventType, expected] of cases) {
    it(`maps ${eventType} → ${expected}`, () => {
      expect(eventToState(eventType)).toBe(expected);
    });
  }

  it('returns null for unknown event types (caller ignores them)', () => {
    expect(eventToState('something-else')).toBeNull();
  });
});

describe('canSubmit — double-submit guard', () => {
  it('allows submit from resting states', () => {
    expect(canSubmit(DemoState.IDLE)).toBe(true);
    expect(canSubmit(DemoState.SUCCEEDED)).toBe(true);
    expect(canSubmit(DemoState.FAILED)).toBe(true);
    expect(canSubmit(DemoState.CANCELLED)).toBe(true);
  });

  it('blocks submit while validating/preparing/running/cancelling', () => {
    for (const state of [
      DemoState.VALIDATING,
      DemoState.PREPARING,
      DemoState.INITIALIZING_SANDBOX,
      DemoState.RUNNING_IN_BROWSER,
      DemoState.FALLING_BACK_TO_SERVER,
      DemoState.RUNNING_ON_SERVER,
      DemoState.CANCELLING,
    ]) {
      expect(canSubmit(state)).toBe(false);
    }
  });
});

describe('isRunning / isTerminal', () => {
  it('isRunning covers the busy window', () => {
    expect(isRunning(DemoState.VALIDATING)).toBe(true);
    expect(isRunning(DemoState.PREPARING)).toBe(true);
    expect(isRunning(DemoState.CANCELLING)).toBe(true);
    expect(isRunning(DemoState.IDLE)).toBe(false);
    expect(isRunning(DemoState.SUCCEEDED)).toBe(false);
  });

  it('isTerminal covers succeeded/failed/cancelled', () => {
    expect(isTerminal(DemoState.SUCCEEDED)).toBe(true);
    expect(isTerminal(DemoState.FAILED)).toBe(true);
    expect(isTerminal(DemoState.CANCELLED)).toBe(true);
    expect(isTerminal(DemoState.RUNNING_IN_BROWSER)).toBe(false);
  });
});

describe('reduceDemoState — SUBMIT / VALIDATED / VALIDATION_FAILED', () => {
  it('SUBMIT from idle moves to validating', () => {
    expect(reduceDemoState(createDemoState(), { type: 'SUBMIT' })).toEqual({
      state: DemoState.VALIDATING,
      errorCode: null,
    });
  });

  it('SUBMIT is ignored while running (busy guard)', () => {
    const busy = reduceDemoState(createDemoState(), { type: 'SUBMIT' });
    expect(reduceDemoState(busy, { type: 'SUBMIT' })).toEqual(busy);
  });

  it('SUBMIT is allowed again after succeeded/failed/cancelled (retry)', () => {
    for (const terminal of [DemoState.SUCCEEDED, DemoState.FAILED, DemoState.CANCELLED]) {
      const current = { state: terminal, errorCode: null };
      expect(reduceDemoState(current, { type: 'SUBMIT' }).state).toBe(DemoState.VALIDATING);
    }
  });

  it('VALIDATED moves to preparing and clears the error code', () => {
    const current = { state: DemoState.VALIDATING, errorCode: 'oops' };
    expect(reduceDemoState(current, { type: 'VALIDATED' })).toEqual({
      state: DemoState.PREPARING,
      errorCode: null,
    });
  });

  it('VALIDATION_FAILED moves to failed with an input error code', () => {
    const current = { state: DemoState.VALIDATING, errorCode: null };
    expect(reduceDemoState(current, { type: 'VALIDATION_FAILED' })).toEqual({
      state: DemoState.FAILED,
      errorCode: 'input_error',
    });
  });
});

describe('reduceDemoState — SDK event stream', () => {
  it('runs a browser success flow idle→…→succeeded', () => {
    let state = createDemoState();
    state = reduceDemoState(state, { type: 'SUBMIT' });
    state = reduceDemoState(state, { type: 'VALIDATED' });
    for (const eventType of ['manifest-fetch-started', 'manifest-fetch-completed', 'code-fetch-started', 'code-fetch-completed']) {
      state = reduceDemoState(state, { type: 'SDK_EVENT', eventType });
      expect(state.state).toBe(DemoState.PREPARING);
    }
    state = reduceDemoState(state, { type: 'SDK_EVENT', eventType: 'browser-execution-started' });
    expect(state.state).toBe(DemoState.RUNNING_IN_BROWSER);
    state = reduceDemoState(state, { type: 'SDK_EVENT', eventType: 'completed' });
    expect(state.state).toBe(DemoState.SUCCEEDED);
  });

  it('shows the live browser-failure → fallback transition', () => {
    let state = reduceDemoState(reduceDemoState(createDemoState(), { type: 'SUBMIT' }), { type: 'VALIDATED' });
    state = reduceDemoState(state, { type: 'SDK_EVENT', eventType: 'browser-execution-started' });
    expect(state.state).toBe(DemoState.RUNNING_IN_BROWSER);
    state = reduceDemoState(state, { type: 'SDK_EVENT', eventType: 'browser-execution-failed' });
    expect(state.state).toBe(DemoState.FALLING_BACK_TO_SERVER);
    state = reduceDemoState(state, { type: 'SDK_EVENT', eventType: 'fallback-started' });
    expect(state.state).toBe(DemoState.FALLING_BACK_TO_SERVER);
    state = reduceDemoState(state, { type: 'SDK_EVENT', eventType: 'server-execution-started' });
    expect(state.state).toBe(DemoState.RUNNING_ON_SERVER);
    state = reduceDemoState(state, { type: 'SDK_EVENT', eventType: 'completed' });
    expect(state.state).toBe(DemoState.SUCCEEDED);
  });

  it('maps cancel-requested → cancelling and cancelled → cancelled', () => {
    let state = reduceDemoState(reduceDemoState(createDemoState(), { type: 'SUBMIT' }), { type: 'VALIDATED' });
    state = reduceDemoState(state, { type: 'SDK_EVENT', eventType: 'browser-execution-started' });
    state = reduceDemoState(state, { type: 'SDK_EVENT', eventType: 'cancel-requested' });
    expect(state.state).toBe(DemoState.CANCELLING);
    state = reduceDemoState(state, { type: 'SDK_EVENT', eventType: 'cancelled' });
    expect(state.state).toBe(DemoState.CANCELLED);
  });

  it('records the error code carried by a failed event', () => {
    let state = reduceDemoState(reduceDemoState(createDemoState(), { type: 'SUBMIT' }), { type: 'VALIDATED' });
    state = reduceDemoState(state, { type: 'SDK_EVENT', eventType: 'failed', errorCode: 'function_failed' });
    expect(state).toEqual({ state: DemoState.FAILED, errorCode: 'function_failed' });
  });

  it('keeps a previous error code when a non-failed event arrives', () => {
    let state = reduceDemoState(reduceDemoState(createDemoState(), { type: 'SUBMIT' }), { type: 'VALIDATED' });
    state = reduceDemoState(state, { type: 'SDK_EVENT', eventType: 'failed', errorCode: 'manifest_fetch_failed' });
    state = reduceDemoState(state, { type: 'SDK_EVENT', eventType: 'accepted' });
    expect(state.errorCode).toBe('manifest_fetch_failed');
  });

  it('ignores unknown event types without crashing', () => {
    let state = reduceDemoState(reduceDemoState(createDemoState(), { type: 'SUBMIT' }), { type: 'VALIDATED' });
    const before = state;
    expect(reduceDemoState(state, { type: 'SDK_EVENT', eventType: 'mystery-event' })).toEqual(before);
  });

  it('RESET returns to a fresh idle state', () => {
    let state = reduceDemoState(reduceDemoState(createDemoState(), { type: 'SUBMIT' }), { type: 'VALIDATED' });
    state = reduceDemoState(state, { type: 'RESET' });
    expect(state).toEqual(createDemoState());
  });
});
