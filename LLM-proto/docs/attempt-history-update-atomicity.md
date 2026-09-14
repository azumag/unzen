# Attempt-history update atomicity

Issue #756 hardens the mutable half of the attempt-history repository contract. `appendAttempt()` and `listAttempts()` already detach records; `updateAttempt()` must likewise treat its caller-owned patch as untrusted runtime input.

## Target lookup first

Both repository adapters locate the request's stored attempt and return immediately when the request or attempt is unknown. Caller patch getters are not evaluated on that early-return path.

This keeps an update for a stale or unknown attempt side-effect free even when the supplied patch is accessor- or Proxy-backed.

## Snapshot before mutation

For an existing attempt, `updateAttempt()` captures the three patch fields in fixed order before changing repository state:

1. `finishedAt`
2. `outcome`
3. `errorCode`

Each property is read exactly once. The patch object is never enumerated. Only after all three reads succeed are defined values applied to the stored attempt.

Consequences:

- a getter cannot return one value for a check and another value for assignment;
- if any patch getter throws, no earlier field has been applied and the stored attempt remains unchanged;
- `undefined` keeps its existing meaning of “do not update this field”;
- the behavior is the same for `InMemoryRepository` and `DurableObjectRepository`, including a backing store that preserves JavaScript references instead of cloning values.

## Repository mutation boundary

`updateAttempt()` remains the sole explicit mutation path for post-append attempt outcome/timing/error fields. Reads from `listAttempts()` stay detached, so editing a status/read result cannot bypass this update contract.

## Regression coverage

`tests/attempt-history-update-isolation.test.ts` runs the same checks against the in-memory adapter and the Durable Object adapter backed by reference-preserving KV storage. It covers single-read capture with hostile second values, a throwing later getter with no partial write, unknown-attempt early return without getter evaluation, non-enumeration, and `undefined` partial-patch semantics.
