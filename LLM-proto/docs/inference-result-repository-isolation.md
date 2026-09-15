# Committed inference-result repository isolation

`commitCompletion()` treats the supplied `InferenceResult` as caller-owned runtime input. Duplicate and stage-conflict checks run before the result is inspected, preserving the existing exactly-once early-return behavior.

Once a completion is known to be commit-eligible, both repository adapters capture `requestId`, the `tokens` reference, `text`, `totalTimeMs`, and `segmentsCompleted` exactly once. The token-array length is captured once and token IDs are copied by numeric index into a new repository-owned array. The copy does not enumerate the result object or require the token array's iterator.

The external `commitCompletion(requestId, ...)` route identity is then compared exactly with the owned snapshot's `requestId`. A mismatch fails closed with `ProtocolViolation` before the result is written or the request stage / `completedAt` is mutated. No trimming or coercion is applied, and the same owned result snapshot that passed this identity fence is the value persisted on the successful path.

Only that owned plain snapshot is persisted. `getResult()` returns a second detached snapshot, including a freshly copied token array, rather than exposing the repository-owned record. A caller retaining the commit input, its token array, or a value returned from `getResult()` therefore cannot mutate an already committed result without another repository operation.

This contract is explicit in both `InMemoryRepository` and `DurableObjectRepository`; it does not depend on Durable Object storage structured-clone behavior. Storage keying and duplicate/conflict outcomes remain unchanged, while commit-eligible route/result identity drift is rejected before any completion-state mutation.

The cross-adapter regression suite uses a reference-preserving KV test double to verify single-read capture, non-iterator token copying, retained-input isolation, detached reads, commit-eligible mismatch/no-mutation behavior, valid-first/changed-second request-identity accessors, and hostile-input duplicate/conflict early returns.
