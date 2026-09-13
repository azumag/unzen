# Prototype transport connection-history contract

`AllowlistedPrototypeTransport` records the canonical network origins touched by the contract-tested coordinator prototypes. That history is evidence used by the 2-worker, adaptive-dispatcher, and Workers coordinator reports, so callers must not be able to rewrite it through a TypeScript-only `readonly` view.

## Ownership boundary

- The internal connection log remains transport-owned mutable state.
- `connections` returns a frozen snapshot. Mutating or retaining the returned array cannot change the transport's later `connectionCount` or history.
- `connectionsSince(index)` also returns a frozen snapshot rather than a live view.
- `allowlist` keeps its existing constructor-owned frozen snapshot semantics.

## History cursor contract

`connectionsSince(index)` treats its cursor as runtime input even though the TypeScript API accepts `number`.

A valid cursor is a non-negative safe integer between `0` and the current `connectionCount`, inclusive. `connectionCount` itself is valid and returns an empty frozen snapshot. Negative, fractional, non-finite, non-number, and out-of-range cursors fail before history is read or mutated.

This keeps run-local evidence deterministic: callers may capture `connectionCount` before a run and later request exactly the origins appended by that run without exposing the underlying log.

## Non-goals

This contract does not change network allowlisting, origin canonicalization, connection ordering, or production networking. It is evidence-integrity hardening for the prototype path and does not count as real multi-browser/WebGPU evidence for #167.
