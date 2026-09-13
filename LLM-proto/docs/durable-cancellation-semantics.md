# Durable cancellation semantics

Issue #184 tightens `DurableCoordinator.cancel()` so cancellation is a durable request-state command rather than a lookup in one process-local `inFlight` map. Issue #551 additionally makes the cancellation request ID an explicit runtime trust boundary.

## Rules

1. `cancel(requestId)` first validates that the runtime value is an actual non-empty string, before any durable lookup, state mutation, or diagnostic interpolation. Malformed values fail with `ErrorCode.ProtocolViolation`. Accepted strings are not trimmed or canonicalized. A valid non-empty but unknown request ID then fails with `ErrorCode.RequestNotFound`; no cancellation tombstone is created for either case.
2. Completed and failed requests stay unchanged. The returned acknowledgement reports `already-completed` or `already-failed`, and a completed result is never overwritten.
3. For an active request, the Coordinator writes the durable `CancellationRecord` **before** aborting local work or invalidating the active lease. Any Coordinator instance that subsequently tries to dispatch or commit checks that record and fails closed.
4. The request is moved to `cancelled`, checkpoints are removed, and the active lease is invalidated. The active attempt is marked `cancelled` when its lease identity is available.
5. A late result after cancellation is suppressed as `kind: cancelled`; it does not isolate a healthy worker merely because cancellation already removed the lease, and it can never commit a checkpoint or final result.
6. Cancellation retries are idempotent. A second call preserves the original `requestedAt`, `deadlineMs`, and acknowledgement state.

## Acknowledgement meaning

`CancellationAck.acknowledged` means **the execution owner has been confirmed settled**, not simply that the Coordinator making the call has no local `inFlight` entry.

- queued/retry-wait work with no local owner and no active lease can be cancelled and acknowledged immediately;
- a local in-flight execution returns `pending-stop`, aborts its `AbortSignal`, and is acknowledged only from the owning run's `finally` path after it settles;
- a reconstructed Coordinator cancelling a request that still had an active lease terminalizes the durable request and invalidates the lease, but returns `pending-stop`. It does not claim that a remote executor physically stopped merely because its lease was removed;
- repeating that cancellation remains unacknowledged until the original owner settles. The absence of a lease on the retry is not used to manufacture an acknowledgement.

`cancelAckDeadlineMs` is an observability/operator target for cancellation acknowledgement. Crossing it does not turn an unconfirmed stop into an acknowledgement.

## Cross-instance safety

The execution path checks durable cancellation before issuing a new assignment and again before accepting a worker result. Intermediate checkpoint validation also re-checks cancellation after its asynchronous digest verification, so a cancellation that races validation cannot commit afterward.

This contract is exercised against both `InMemoryRepository` and clone-on-access `DurableObjectRepository` storage. The request-ID boundary is covered separately by `durable-cancellation-request-id-envelope.test.ts`, including coercion-sensitive malformed values and no-mutation assertions for request, lease, attempt, worker, cancellation, and suppression state.
