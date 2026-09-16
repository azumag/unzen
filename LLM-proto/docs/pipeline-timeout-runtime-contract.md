# Pipeline Timeout Runtime Contract

`pipeline-utils.ts` exposes timeout and delay primitives with different
cancellation semantics. `withAbortableTimeout()` is used by the legacy Pipeline,
SpanPipeline, and DurableCoordinator, legacy `withTimeout()` remains in use by
swarm proposal/evaluation paths, and `delay()` is the shared retry/backoff sleep.
Values can cross JSON, test-double, plugin, or type-assertion boundaries, so
TypeScript signatures are not treated as runtime validation.

JavaScript host timers represent delay values with a signed 32-bit range. The
shared timeout boundary therefore exports `MAX_TIMER_DELAY_MS=2147483647`; larger
positive values are rejected instead of being passed to a host where they may
overflow or execute immediately.

## Abortable timeout preflight contract

Before a timer is armed, an external abort listener is registered, or the
execution factory is invoked, `withAbortableTimeout()` validates:

- `factory` is callable;
- `timeoutMs` is a finite, non-negative number no greater than
  `MAX_TIMER_DELAY_MS` (`0` remains an immediate timeout);
- `label` is a non-empty string;
- an optional external signal structurally exposes a boolean `aborted` plus
  callable `addEventListener` and `removeEventListener` methods.

The signal check is structural rather than `instanceof AbortSignal`, so a valid
signal originating from another JavaScript realm is not rejected solely because
its prototype identity differs.

Malformed or unsupported inputs reject without partially arming timeout machinery
or invoking the execution factory. This keeps failure ordering deterministic and
prevents a bad runtime envelope from leaving a timer/listener side effect behind.

After preflight, cancellation subscription is treated as a race-sensitive
boundary. The helper checks an already-aborted signal, registers the abort
listener, and then checks `aborted` again before invoking the execution factory.
The post-registration check closes the window where abort can be dispatched after
the first check but before the listener becomes active. If cancellation wins that
window, the inner controller is aborted, the timeout/listener are cleaned up, the
returned promise rejects as `AbortError`, and the factory is not invoked.

Structural signal implementations are allowed by this boundary, so subscription
and cleanup are also fail-safe: a throwing `addEventListener` rejects without
leaving the already-armed timeout behind, a throwing `removeEventListener` cannot
prevent promise settlement, and a signal that invokes its listener synchronously
before finishing registration receives a second cleanup after registration
returns.

## Legacy timeout preflight contract

Before `withTimeout()` arms its timer, it validates:

- `timeoutMs` is a finite, non-negative number no greater than
  `MAX_TIMER_DELAY_MS` (`0` remains an immediate timeout for pending work);
- `label` is a non-empty string;
- the input is structurally promise-like and exposes a callable `then` method.

The promise-like check is structural instead of `instanceof Promise`, preserving
cross-realm promises and compatible thenables. The validated `then` function is
snapshotted before timer creation, so an accessor cannot pass preflight and then
change or throw only after a timer has been armed. If subscription itself throws,
the timer is cleared before that error is propagated.

## Shared delay preflight contract

`delay(ms)` is also an exported host-timer boundary. Before a positive delay is
passed to `setTimeout()`, it requires `ms` to be a finite number and no greater
than `MAX_TIMER_DELAY_MS`. Non-number values, `NaN`, infinities, and oversized
positive delays return a rejected promise without registering a timer.

The existing finite non-positive behavior remains unchanged: `delay(0)` and
finite negative delays resolve immediately and register no timer. The exact
`MAX_TIMER_DELAY_MS` value remains supported. This preserves current retry/backoff
callers while preventing decoded/asserted/plugin values from being coerced or
overflowing in the host timer implementation.

## Valid-call semantics

The established behavior is unchanged for valid callers:

- `withAbortableTimeout()` per-segment timeout aborts the inner controller and
  rejects with `SegmentTimeoutError`;
- an external abort aborts the inner controller and rejects as `AbortError`;
- successful abortable execution clears the timer/listener and returns the
  factory value;
- the abortable returned promise still settles even if underlying work ignores
  the abort signal;
- `withTimeout()` continues to race legacy promise-like work against the timeout,
  preserves the existing `${label} timed out after ${timeoutMs}ms` diagnostic,
  and propagates successful or rejected work settlement unchanged;
- `delay()` keeps finite non-positive values as immediate resolution and arms
  one bounded timer for valid positive values.

## Evidence boundary

This contract is coordinator/swarm-side reliability coverage. It verifies timeout
and delay preflight, cleanup, host timer range enforcement, and cooperative signal
propagation in the TypeScript harness. It does not prove that a real
browser/WebGPU backend consumes a signal promptly, nor does it provide real
prepared-1B, physical GPU working-set, multi-browser relay, or worker-loss-resume
evidence for issue #167.
