# Durable Coordinator recovery planning

Issue #183 separates two restart concerns that were previously easy to conflate:

1. **completed replay** — reading an already committed result after a new Coordinator instance is constructed;
2. **in-progress recovery** — deciding what to do with persisted `accepted`, `queued`, `leased`, `running`, or `retry-wait` state after the original process disappears.

The first behavior already exists. This document and `src/durable-recovery-plan.ts` establish the deterministic decision layer required for the second.

## Recovery inputs

The planner consumes only persisted state:

- request record, including `createdAt`, `timeoutMs`, `currentSegment`, manifest digest, and retry count;
- active lease, if any;
- persisted checkpoints for the request;
- durable cancellation presence;
- current time and the configured retry budget.

It does **not** consult process-local `inFlight`, timers, or AbortControllers.

## Decisions

A recovery scan produces one of the following commands:

- `terminal`: nothing to execute because the request already completed/failed/cancelled;
- `cancel`: durable cancellation wins before dispatch;
- `wait-active-owner`: a matching lease has not expired, so another execution owner may still be active and recovery must not double-execute;
- `resume`: the request can be normalized back to the scheduling queue and continue from `currentSegment`;
- `fail`: recovery cannot safely continue (deadline, retry budget, manifest identity, lease identity, or checkpoint integrity).

For `resume` after an abandoned lease, the exact lease is returned as `reclaimLease`. The mutating recovery layer must compare-and-delete that identity; request-wide lease deletion is not sufficient because a concurrent owner may have installed a replacement lease.

## Invariants

### Absolute deadline survives restart

A request deadline is derived from `createdAt + timeoutMs`. Restart never grants a new timeout window.

### Retry budget survives restart

`retryCount` is persisted and compared against the original `maxRetries`. Recovery never resets it to zero.

### Continuation requires a valid predecessor checkpoint

When `currentSegment > 0`, the planner requires the checkpoint produced by `currentSegment - 1`, bound to the same request and manifest and still within TTL. Missing, expired, or cross-manifest checkpoints fail closed.

### Active owner is not duplicated

A valid non-expired active lease yields `wait-active-owner`. Recovery does not infer process death merely because the current Coordinator has no local `inFlight` entry.

## Scope of this PR

This is the pure, testable recovery decision layer. It intentionally does **not** yet mutate stages or start execution. Issue #183 remains open until a repository-backed recovery command applies these decisions atomically, including concurrent-recovery ownership, abandoned-lease compare-and-delete, bounded waiting for active owners, and terminalization of unrecoverable requests.

The split is deliberate: restart policy can now be reviewed and tested independently before it is allowed to mutate live durable state.
