# Pipeline Timeout Runtime Contract

`withAbortableTimeout()` is the shared timeout/cancellation primitive used by the
legacy Pipeline, SpanPipeline, and DurableCoordinator. Because values can cross
JSON, test-double, plugin, or type-assertion boundaries, its TypeScript signature
is not treated as runtime validation.

## Preflight contract

Before a timer is armed, an external abort listener is registered, or the
execution factory is invoked, the utility validates:

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

## Valid-call semantics

The established behavior is unchanged for valid callers:

- a per-segment timeout aborts the inner controller and rejects with
  `SegmentTimeoutError`;
- an external abort aborts the inner controller and rejects as `AbortError`;
- successful execution clears the timer/listener and returns the factory value;
- the returned promise still settles even if underlying work ignores the abort
  signal.

## Evidence boundary

This contract is coordinator-side reliability coverage. It verifies timeout
preflight and cooperative signal propagation in the TypeScript harness. It does
not prove that a real browser/WebGPU backend consumes the signal promptly, nor
does it provide real prepared-1B, physical GPU working-set, multi-browser relay,
or worker-loss-resume evidence for issue #167.
