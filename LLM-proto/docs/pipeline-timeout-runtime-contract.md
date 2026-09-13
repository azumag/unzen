# Pipeline Timeout Runtime Contract

`pipeline-utils.ts` exposes two timeout primitives with different cancellation
semantics. `withAbortableTimeout()` is used by the legacy Pipeline, SpanPipeline,
and DurableCoordinator, while legacy `withTimeout()` remains in use by swarm
proposal/evaluation paths. Values can cross JSON, test-double, plugin, or
type-assertion boundaries, so TypeScript signatures are not treated as runtime
validation.

## Abortable timeout preflight contract

Before a timer is armed, an external abort listener is registered, or the
execution factory is invoked, `withAbortableTimeout()` validates:

- `factory` is callable;
- `timeoutMs` is a finite, non-negative number (`0` remains an immediate timeout);
- `label` is a non-empty string;
- an optional external signal structurally exposes a boolean `aborted` plus
  callable `addEventListener` and `removeEventListener` methods.

The signal check is structural rather than `instanceof AbortSignal`, so a valid
signal originating from another JavaScript realm is not rejected solely because
its prototype identity differs.

Malformed inputs reject without partially arming timeout machinery or invoking
the execution factory. This keeps failure ordering deterministic and prevents a
bad runtime envelope from leaving a timer/listener side effect behind.

## Legacy timeout preflight contract

Before `withTimeout()` arms its timer, it validates:

- `timeoutMs` is a finite, non-negative number (`0` remains an immediate timeout
  for pending work);
- `label` is a non-empty string;
- the input is structurally promise-like and exposes a callable `then` method.

The promise-like check is structural instead of `instanceof Promise`, preserving
cross-realm promises and compatible thenables. The validated `then` function is
snapshotted before timer creation, so an accessor cannot pass preflight and then
change or throw only after a timer has been armed. If subscription itself throws,
the timer is cleared before that error is propagated.

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
  and propagates successful or rejected work settlement unchanged.

## Evidence boundary

This contract is coordinator/swarm-side reliability coverage. It verifies timeout
preflight, cleanup, and cooperative signal propagation in the TypeScript harness.
It does not prove that a real browser/WebGPU backend consumes a signal promptly,
nor does it provide real prepared-1B, physical GPU working-set, multi-browser
relay, or worker-loss-resume evidence for issue #167.
