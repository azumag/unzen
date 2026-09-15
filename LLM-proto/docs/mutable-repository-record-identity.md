# Mutable repository record identity and capability guards

The durable repository retains one compatibility exception to the general detached-read model: `RequestRecord` and `WorkerRecord` values returned by `get*()` / `list*()` remain mutable so the Coordinator and WorkerRegistry can update operational state in place.

That compatibility does not make immutable request specification, durable identity, or validated routing trust mutable. A request's `requestId` defines its storage key, while `prompt`, `idempotencyKey`, `createdAt`, `totalSegments`, `manifestDigest`, and `timeoutMs` define the accepted request and recovery/execution trust boundary. In particular, `totalSegments` controls pipeline progress/final-segment decisions, `manifestDigest` participates in recovery integrity checks, and `createdAt` plus `timeoutMs` define the absolute recovery deadline. These values must not be rewritten through a retained repository read after acceptance.

A worker's `workerId` defines its storage key, `generation` defines the active transport/auth generation used by stale-generation fencing, and `connectionId` distinguishes a same-session capability refresh from a reconnect that must revoke the old generation and issue a new one. `tier` and `vramMB` are routing trust inputs: `WorkerRegistry.getAvailableWorker()` filters by VRAM and ranks by tier and then VRAM. `registeredAt` records the validated creation time of that generation and is preserved into revoked-generation history. Rewriting any of those fields through a previously returned record would create key/value identity drift, bypass the explicit worker replacement path, influence routing without validation, or corrupt generation provenance.

Both repository adapters therefore reject assignment, deletion, and `Object.defineProperty` / `Reflect.defineProperty` changes to:

- `RequestRecord.requestId`, `prompt`, `idempotencyKey`, `createdAt`, `totalSegments`, `manifestDigest`, and `timeoutMs`
- `WorkerRecord.workerId`, `generation`, `connectionId`, `tier`, `vramMB`, and `registeredAt`

The rejection is a `ProtocolViolation` and happens before the returned proxy target or durable state can change. Diagnostics name only fixed schema fields and never interpolate caller-controlled values.

Operational fields remain mutable under the existing #103 contract. Request operational state includes `stage`, `startedAt`, `completedAt`, `currentSegment`, `retryCount`, `lastErrorCode`, and `lastError`; worker operational state includes stage, heartbeat, revocation timestamp, and current segment. `InMemoryRepository` applies these changes directly to the repository-owned target; `DurableObjectRepository` keeps its write-through merge behavior so a property update is applied to the latest stored record rather than overwriting newer state with a stale clone.

Worker generation or connection replacement continues to happen through `WorkerRegistry.register()` and `putWorker()`. A proxy read from an older generation remains fenced from writing to a later replacement generation, while the guard additionally prevents that stale proxy from changing identity, connection, routing capability, or registration provenance to evade fencing or alter archived history.

Capability updates also remain supported, but only through the validated registration path. Re-registering on the same connection may update `tier` and `vramMB` while keeping the current generation and its original `registeredAt`. A reconnect creates a new generation with a new registration timestamp and archives the previous generation with its original timestamp. Direct or list reads cannot spoof those values.

Cross-adapter tests cover mutable operational writes, rejected request-specification and worker identity/capability/provenance assignment/deletion/defineProperty operations, unchanged protected fields after failed mutations, recovery manifest/deadline behavior after rejected request spoof attempts, stale-proxy behavior after worker generation replacement, generation provenance across reconnect archival, and routing behavior before and after a validated same-connection tier/VRAM refresh.
