# Repository route identity contract

Issue #768 hardens repository write APIs that carry the same request identity twice: once as the route/key argument and again inside the record being persisted.

## Invariant

For these writes:

- `appendAttempt(requestId, attempt)`
- `putCancellation(requestId, record)`

the external `requestId` must exactly equal the `requestId` captured from the repository-owned record snapshot. Equality is strict; values are not trimmed, normalized, or coerced.

The record is snapshotted before mutation, and the same owned snapshot that passed the identity check is used for the actual persistence key and value. This prevents getter/Proxy drift between validation and storage.

A mismatch fails closed with `UnzenError` / `ErrorCode.ProtocolViolation` before either the attempt-list bucket or cancellation slot is mutated. No state is written under the route identity or the embedded record identity.

## Adapter parity

`InMemoryRepository` and `DurableObjectRepository` enforce the same rule. The Durable Object adapter does not rely on storage clone behavior for correctness.

Existing matching call paths are unchanged:

- attempt ordering remains append-only;
- cancellation acknowledgement still persists only when the detached cancellation record is explicitly written back;
- record snapshot isolation and optional-field presence semantics remain intact.

`commitCompletion()` is intentionally outside this contract because it has a separate duplicate/stage-conflict early-return contract.

## Regression coverage

`tests/repository-route-identity.test.ts` runs the contract against both repository adapters, including a deliberately reference-preserving Durable Object KV double. It covers mismatch/no-mutation, matching controls, valid-first/changed-second `requestId` accessors, single-read binding, and non-enumeration.