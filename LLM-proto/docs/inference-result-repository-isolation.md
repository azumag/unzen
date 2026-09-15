# Committed inference-result repository isolation

`commitCompletion()` treats the supplied `InferenceResult` as caller-owned runtime input. Duplicate and stage-conflict checks run before the result is inspected, preserving the existing exactly-once early-return behavior.

On a successful commit, both repository adapters capture `requestId`, the `tokens` reference, `text`, `totalTimeMs`, and `segmentsCompleted` exactly once. The token-array length is captured once and token IDs are copied by numeric index into a new repository-owned array. The copy does not enumerate the result object or require the token array's iterator.

Only that owned plain snapshot is persisted. `getResult()` returns a second detached snapshot, including a freshly copied token array, rather than exposing the repository-owned record. A caller retaining the commit input, its token array, or a value returned from `getResult()` therefore cannot mutate an already committed result without another repository operation.

This contract is explicit in both `InMemoryRepository` and `DurableObjectRepository`; it does not depend on Durable Object storage structured-clone behavior. It intentionally adds no new value-validation or request/result identity policy: storage keying, duplicate/conflict outcomes, and stage compare-and-set behavior remain unchanged.

The cross-adapter regression suite uses a reference-preserving KV test double to verify single-read capture, non-iterator token copying, retained-input isolation, detached reads, and hostile-input duplicate/conflict early returns.
