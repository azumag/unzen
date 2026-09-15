# Mutable repository record identity guards

The durable repository retains one compatibility exception to the general detached-read model: `RequestRecord` and `WorkerRecord` values returned by `get*()` / `list*()` remain mutable so the Coordinator and WorkerRegistry can update operational state in place.

That compatibility does not make durable identity mutable. A request's `requestId` defines its storage key. A worker's `workerId` defines its storage key, `generation` defines the active transport/auth generation used by stale-generation fencing, and `connectionId` distinguishes a same-session capability refresh from a reconnect that must revoke the old generation and issue a new one. Rewriting any of those fields through a previously returned record would create key/value identity drift or bypass the explicit worker replacement path.

Both repository adapters therefore reject assignment, deletion, and `Object.defineProperty` / `Reflect.defineProperty` changes to:

- `RequestRecord.requestId`
- `WorkerRecord.workerId`
- `WorkerRecord.generation`
- `WorkerRecord.connectionId`

The rejection is a `ProtocolViolation` and happens before the returned proxy target or durable state can change. Diagnostics name only fixed schema fields and never interpolate caller-controlled identity values.

Operational fields remain mutable under the existing #103 contract. Examples include request stage/retry/error state and worker stage/heartbeat/current-segment state. `InMemoryRepository` applies these changes directly to the repository-owned target; `DurableObjectRepository` keeps its write-through merge behavior so a property update is applied to the latest stored record rather than overwriting a newer stage with a stale clone.

Worker generation or connection replacement continues to happen through `WorkerRegistry.register()` and `putWorker()`. A proxy read from an older generation remains fenced from writing to a later replacement generation, while the identity guard additionally prevents that stale proxy from changing its own `workerId`, `generation`, or `connectionId` to evade reconnect or generation fencing. Explicit re-registration on the same connection remains a supported capability refresh that keeps the generation.

Cross-adapter tests cover mutable operational writes, rejected identity assignment/deletion/defineProperty operations from both direct and list reads, unchanged key/value identity after failed mutations, stale-proxy behavior after generation replacement, and the registry reconnect path after a rejected connection-identity spoof.
