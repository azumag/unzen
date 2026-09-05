# Durable Coordinator recovery runner

`src/durable-recovery-runner.ts` adds the bounded orchestration layer above the repository-backed recovery command from #198.

The command itself intentionally returns `owned-by-peer` or `wait-active-owner` instead of sleeping. The runner turns those states into bounded waits and re-plans from durable state after each wait.

## Wait bounds

Recovery does not reuse the old unbounded `waitForTerminalResult()` behavior.

- peer recovery owner: wait at most until the recovery ownership expires, while polling sooner for a terminal transition;
- active execution owner: wait at most until the active lease expires;
- request deadline: when present, it is always the tighter bound than lease expiry;
- caller cancellation: aborts the wait immediately.

When a request reaches its original absolute deadline while another lease is still present, the next recovery command terminalizes it with the structured deadline error and reclaims only the exact persisted lease selected by the planner.

## Resume handoff

When the command returns `resume-claimed`, the runner invokes `onResume()` while the durable recovery ownership remains held. The callback contract is intentionally strict: it must not return until either

1. durable execution ownership is established (for example a worker execution lease/epoch is installed), or
2. the request has reached a terminal state.

The runner renews the recovery ownership while the callback is in progress. If another owner somehow replaces the claim, the resume signal is aborted and the runner surfaces an ownership-loss error instead of continuing under stale authority.

The claim is compare-and-delete released after the callback settles. A stale process therefore cannot release a newer owner's claim.

## Remaining #183 integration

The recovery planner, atomic command, ownership store and bounded runner now exist independently and are covered against both in-memory and clone-on-access Durable Object storage.

The remaining step is wiring `DurableCoordinator` itself:

- idempotent replay of a persisted non-terminal request should invoke this runner instead of only polling;
- an explicit startup/recovery scan should invoke it for persisted non-terminal requests;
- the resume callback must enter the existing segment execution path at `currentSegment`, preserving retry count, predecessor checkpoint and original deadline;
- the callback must establish durable execution ownership before returning, so the recovery claim is never dropped into an ownerless gap.

Until that wiring lands, #183 remains open and automatic restart recovery is not yet claimed complete.
