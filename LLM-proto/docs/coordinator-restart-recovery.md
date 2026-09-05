# Durable Coordinator restart recovery

The durable recovery planner, repository-backed recovery command, and bounded recovery runner are now connected to `DurableCoordinator`.

## Recovery entry points

There are two supported entry points:

1. **Idempotent replay.** If `submit()` receives an idempotency key already bound to a persisted non-terminal request and this Coordinator has no local in-flight execution, it starts bounded durable recovery for that request instead of polling the repository forever.
2. **Startup scan.** `recoverPendingRequests()` returns recovery-backed submission handles for every persisted non-terminal request. A runtime can call it after reconstructing the repository and worker registry.

Neither path creates a new request ID or resets persisted execution state.

## Preserved state

Recovery preserves:

- original `requestId` and manifest digest;
- original `createdAt + timeoutMs` deadline;
- original `startedAt` if execution had already begun;
- persisted `currentSegment`;
- validated predecessor checkpoint for continuation segments;
- persisted `retryCount` and the configured maximum retry budget.

The existing segment loop already starts at `currentSegment`, so a request recovered at segment 1 does not rerun segment 0. The existing continuation preflight rejects a missing, expired, cross-request, or cross-manifest checkpoint before worker capacity is reserved.

## Ownership and concurrency

A non-terminal replay no longer calls the old unbounded result poll. It runs through `runDurableRecovery()`:

- a live execution lease is waited on only until its expiry or the original request deadline;
- a live peer recovery claim is waited on only until its durable expiry;
- an abandoned exact lease is reclaimed by the recovery command;
- one recovery owner holds and renews a durable claim while the resumed execution path runs;
- a second reconstructed Coordinator therefore observes the claim and does not execute the same request in parallel.

If recovery ownership is lost while this Coordinator is executing, the recovery signal is aborted without terminalizing the shared request. The replacement owner remains free to continue it.

## Deadline and retry behavior

While recovery is waiting, the runner applies the original absolute deadline. During resumed execution, `DurableCoordinator` installs a timer for only the remaining duration; restart never grants a fresh timeout window.

Execution retry decisions use persisted `retryCount`, not the local loop counter. A request that already consumed its retry budget before restart cannot receive a new retry budget simply because a new process was constructed.

## Cancellation

`cancel()` continues to write the durable cancellation barrier before aborting local execution. A recovery wait or resumed execution uses the same local in-flight controller, so local cancellation wakes it immediately while every other instance observes the durable cancellation marker.

## Verification

The restart recovery integration suite covers:

- idempotent replay of a persisted queued request;
- explicit startup scan using clone-on-access Durable Object storage;
- expired lease recovery;
- continuation from a persisted predecessor checkpoint without rerunning an earlier segment;
- two reconstructed Coordinators sharing one repository, with exactly one execution;
- retry-budget preservation;
- original deadline terminalization before execution.

With this wiring, #183's automatic durable restart-recovery path is implemented at the Coordinator level. Production deployment/evidence remains a separate concern and is not implied by these tests.
