# Durable worker-removal runtime boundary

`DurableCoordinator.removeWorker(workerId)` can be reached from transport lifecycle code, so the branded TypeScript `WorkerId` is not a runtime trust boundary by itself.

The worker registry now validates lookup identities before repository access. A removal ID must be a non-empty runtime string; `null`, `undefined`, numbers, booleans, arrays, objects, symbols, functions, empty strings, and whitespace-only strings fail closed with `UnzenError` / `ErrorCode.ProtocolViolation` and the message `worker lookup workerId must be a non-empty string`.

This validation happens before the active-worker repository lookup. Consequently a malformed removal cannot select a worker generation for revocation and cannot enter the generation-wide lease-reclaim path.

Existing valid-ID semantics are unchanged:

- a valid unknown worker ID remains a no-op;
- a valid known worker removes/revokes the current generation and reclaims leases held by that generation;
- reconnect, heartbeat, generation fencing, and stale-result policies are unchanged.

The lookup validation is shared by `WorkerRegistry.get()`, so public coordinator worker lookup and removal use the same runtime identity contract rather than relying on map-key coercion or silent misses.

Regression coverage is in `tests/durable-coordinator-remove-worker-envelope.test.ts`. It verifies rejection before worker-repository and active-lease lookup, preservation of the registered worker on malformed input, unknown-worker no-op behavior, and the existing known-worker revocation/reclaim path.
