# Cancellation repository isolation

Issue #758 makes cancellation state an explicit repository-owned value boundary instead of relying on JavaScript reference discipline or backing-storage clone behavior.

## Write boundary

`putCancellation(requestId, record)` preserves its existing keying contract but stores a plain owned snapshot of the supplied `CancellationRecord`. The snapshot reads `requestId`, `requestedAt`, and `deadlineMs` exactly once and, when present as an own property, reads `acknowledgedAt` exactly once. The caller object is never enumerated.

An object retained by the caller after `putCancellation()` therefore cannot change durable cancellation identity, timing, deadline, or acknowledgement state.

## Read boundary

`getCancellation()` returns a detached snapshot in both `InMemoryRepository` and `DurableObjectRepository`. Mutating that returned value alone does not change repository state, including when the Durable Object adapter is backed by storage that preserves JavaScript references.

The Coordinator's acknowledgement flow remains compatible with this contract: it reads the cancellation record, sets `acknowledgedAt` on the detached value, and explicitly calls `putCancellation()` again. Only that explicit write-back persists the acknowledgement.

## Optional acknowledgement semantics

The snapshot preserves own-property presence of `acknowledgedAt`, including an explicitly present `undefined` value. This keeps the observable stored shape stable while still preventing live-reference mutation.

## Regression coverage

`tests/cancellation-repository-isolation.test.ts` runs the same contract against the in-memory adapter and the Durable Object adapter backed by reference-preserving KV storage. It covers accessor-backed single reads, refusal to enumerate caller objects, optional-field presence, post-write caller mutation, read-result mutation, and acknowledgement persistence only after explicit write-back.

The existing cross-instance cancellation suite continues to verify that the Coordinator's acknowledge-and-reput path persists `acknowledgedAt` durably.
