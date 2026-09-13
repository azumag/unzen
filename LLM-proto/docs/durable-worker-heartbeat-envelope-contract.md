# Durable worker-heartbeat runtime envelope

Worker heartbeats arrive from a transport boundary, so TypeScript branding cannot be treated as runtime validation. `WorkerRegistry.heartbeat()` validates both identity fields before repository lookup, comparison, diagnostic interpolation, or liveness mutation.

Accepted runtime values are:

- `workerId`: a non-empty string;
- `generation`: a non-empty string.

Malformed values fail closed with `ErrorCode.ProtocolViolation`. This includes coercion-sensitive values such as `Symbol`, so an invalid worker ID cannot reach `UnknownWorkerError` string interpolation and turn a protocol error into an incidental JavaScript `TypeError`.

After this boundary passes, the existing worker-generation semantics remain authoritative:

- a valid current generation updates `lastHeartbeat` and may revive a merely heartbeat-timed-out worker from `disconnected` to `idle`;
- a valid-but-unknown worker ID raises the structured `UnknownWorker` error;
- a valid stale/revoked generation raises the structured `StaleGeneration` error;
- rejected malformed heartbeats do not update heartbeat timestamps, worker stage, generation, or lease ownership.

This is runtime protocol/liveness hardening only. It does not change heartbeat timeout policy, reconnect generation issuance, lease policy, production deployment/credentials, or external evidence requirements. It is not real 1B WebGPU, physical GPU working-set, multi-browser relay, or worker-loss-resume evidence for #167.
