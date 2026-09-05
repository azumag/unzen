# Durable Coordinator recovery command

Issue #183 requires restart recovery to be more than a pure planning decision. A reconstructed Coordinator also needs a durable, concurrency-safe command boundary before it is allowed to mutate an unfinished request.

`src/durable-recovery-command.ts` is that boundary. It consumes the existing pure planner from `durable-recovery-plan.ts`, but first acquires a short-lived recovery ownership record stored in the same `DurableRepository` as the request.

## Why recovery ownership is separate from a worker lease

A restart owner can exist before any execution worker is selected. Reusing a worker lease for that purpose would either invent a fake worker identity or overwrite a real active execution lease. Recovery ownership therefore has its own storage key and lifetime:

- `requestId`
- opaque `ownerId`
- `claimedAt`
- `expiresAt`

`claimRecoveryOwnership` is a single-key compare/replace operation. A live peer owner cannot be overwritten. An expired owner can be replaced, so a crashed recovery process cannot lock the request forever. Release is compare-and-delete by `ownerId`; a stale recovery process cannot release a replacement owner's claim.

The in-memory reference repository and the synchronous SQLite Durable Object repository implement the same contract.

## Command flow

`beginDurableRecovery()` performs these steps without an asynchronous gap:

1. Read the persisted request and return immediately if it is already terminal.
2. Acquire recovery ownership.
3. Re-read request, lease, checkpoints and cancellation after the claim.
4. Run `planDurableRequestRecovery()` against that fresh snapshot.
5. Apply the decision:
   - terminal: release ownership and return;
   - live execution lease: do not disturb it, release ownership, return `wait-active-owner`;
   - cancellation: compare-and-delete the exact old lease, terminalize as cancelled, release ownership;
   - unrecoverable state/deadline/integrity failure: terminalize as failed with the planner's structured error, release ownership;
   - resumable state: compare-and-delete only the exact abandoned lease, normalize the request to `queued`, and return `resume-claimed` while retaining recovery ownership.

For an abandoned `leased` request, `leased -> queued` is a recovery-only CAS normalization performed only after the exact expired lease has been removed under recovery ownership. It is intentionally not added as a general state-machine transition.

## Concurrency rule

A caller that receives `resume-claimed` must keep the recovery claim until a new execution owner is durably established. Only then may it call `releaseDurableRecoveryOwnership()`.

This prevents two reconstructed Coordinators from independently deciding that the same queued/abandoned request is theirs to resume. A peer sees `owned-by-peer` until the current claim is released or expires.

## Current boundary

This change establishes the repository-backed atomic recovery command and clone-on-access storage contract. It does **not** yet make `DurableCoordinator` launch execution from `resume-claimed`.

The remaining #183 wiring is:

- connect idempotent replay / explicit recovery scan to `beginDurableRecovery()`;
- retain the claim until the restarted execution path has installed durable execution ownership;
- bound `wait-active-owner` by the existing lease expiry and original request deadline;
- resume from the validated predecessor checkpoint without rerunning committed segments;
- release/expire the recovery claim on every terminal and exceptional path.

Until that wiring lands, this command must not be described as full automatic restart recovery.
