# Legacy Coordinator worker-message runtime boundary

`Coordinator.handleWorkerMessage()` is a transport-facing runtime boundary. TypeScript's `WorkerMessage` union is not treated as proof that a decoded WebSocket value is well formed.

## Contract

Before dispatch, the Coordinator converts the incoming `unknown` value into one validated owned envelope.

- The top-level discriminator is read exactly once.
- Only after the discriminator is accepted is that variant's `payload` reference read, exactly once.
- Declared payload fields are then read directly and exactly once; unknown properties are never enumerated.
- `worker:register` validates a non-empty worker ID, a supported tier, and positive finite VRAM before `WorkerPool` can change.
- `worker:heartbeat` validates a non-empty worker ID and non-negative finite transport timestamp before heartbeat state changes or an ack is emitted.
- `segment:result` and `segment:failed` remain executor-owned/no-op in the legacy Coordinator, but their declared envelope fields are still captured and scalar identity/range/timing fields are validated so an accessor or Proxy cannot drift between dispatch decisions.
- Unknown discriminators and malformed payloads fail closed before worker state mutation.

The validated message and payload objects are frozen. Nested `segment:result` checkpoint/output objects are not deep-copied because this Coordinator does not consume them; the SegmentExecutor pipeline owns those values and has its own runtime validation boundaries.

## Why the snapshot happens before dispatch

Transport decoders, accessors, or Proxy-backed objects can otherwise return one value during validation and a different value during a later read. Binding dispatch and mutation to one snapshot prevents that time-of-check/time-of-use drift and keeps registration and liveness state derived from the same observed values.

## Compatibility

Normal registration, heartbeat acknowledgement, and executor-owned segment result/failure behavior are unchanged. This hardening is limited to runtime protocol validation and does not change production deployment, credentials, billing, operator authorization, or the evidence status tracked by #167.
