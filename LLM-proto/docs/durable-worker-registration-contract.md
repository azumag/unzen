# Durable worker registration contract

`WorkerRegistry.register()` is a runtime trust boundary. TypeScript types describe coordinator code, but they do not validate worker registration payloads decoded from WebSocket / JSON traffic.

Before the registry reads or mutates durable routing state, a registration must satisfy all of the following:

- `workerId` is a non-empty, non-whitespace string.
- `tier` is exactly `WorkerTier.TIER_1`, `TIER_2`, or `TIER_3`.
- `vramMB` is finite and greater than zero.
- `connectionId` is a non-empty, non-whitespace string.

Validation happens before existing-worker lookup, capability refresh, revocation, generation creation, or repository writes. Consequently, a rejected same-connection refresh cannot poison an existing worker's tier/VRAM, and a rejected reconnect cannot revoke the currently valid generation.

Valid registration semantics are unchanged:

- a new worker creates a fresh generation;
- the same worker on the same connection refreshes capability fields while preserving its generation;
- the same worker on a different connection revokes the old generation and creates a new one.

This contract protects coordinator-side durable routing state only. Passing these checks is not evidence that reported VRAM is physically accurate, that a real WebGPU device can execute the assigned segment, or that the 1B multi-browser relay/resume path has been demonstrated.