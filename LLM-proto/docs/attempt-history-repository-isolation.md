# Attempt-history repository isolation

Issue #754 makes attempt history an explicit repository-owned value boundary instead of relying on caller discipline or backing-storage clone behavior.

## Write boundary

`appendAttempt()` captures the complete `AttemptRecord` into a new plain record before it is stored. Required fields are read in declared order:

1. `requestId`
2. `attemptId`
3. `leaseId`
4. `workerId`
5. `workerGeneration`
6. `segmentIndex`
7. `startedAt`

Optional `finishedAt`, `outcome`, and `errorCode` retain their own-property presence and are read at most once when present. The snapshot helper does not enumerate the caller object, so accessor- or Proxy-backed runtime inputs cannot make persistence depend on `ownKeys()` behavior.

After `appendAttempt()` returns, mutating the retained caller object cannot change persisted attempt identity, timing, outcome, or error state.

## Read boundary

`listAttempts()` returns detached plain snapshots for every attempt. Mutating any returned record cannot change repository state. This contract is identical for `InMemoryRepository` and `DurableObjectRepository`; it does not depend on Cloudflare Durable Object storage performing a structured clone.

## Mutation boundary

`updateAttempt()` remains the only repository API for changing mutable attempt fields after append. Its existing partial-patch semantics are preserved: supplied `finishedAt`, `outcome`, and `errorCode` values are applied to the stored attempt and are visible on subsequent detached reads.

## Why this matters

Attempt history is used for status, recovery, retry, and failure observability. A live object reference escaping this storage boundary lets a consumer bypass the repository mutation path and rewrite historical identity or outcome. Explicit copy-on-write and detached reads keep the in-memory reference implementation behavior aligned with the durable adapter and make attempt history safe even when the backing store preserves JavaScript object references.

## Regression coverage

`tests/attempt-history-repository-isolation.test.ts` runs the same contract against:

- `InMemoryRepository`
- `DurableObjectRepository` backed by a deliberately reference-preserving synchronous KV test double

The suite covers single-read accessor inputs, refusal to enumerate caller objects, optional-field presence, post-append caller mutation, mutation of list results, and `updateAttempt()` after a detached read.
