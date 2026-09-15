# WorkerRegistry absolute-time runtime boundary

`WorkerRegistry` accepts absolute `now` values from transport/runtime callers for registration, heartbeat, liveness evaluation, and generation revocation. TypeScript number types do not prevent decoded or synthetic runtime inputs such as `NaN`, `Infinity`, or negative values from reaching those APIs.

Those values are state and scheduling inputs, not merely diagnostics. Registration persists `registeredAt` and `lastHeartbeat`; heartbeat persists `lastHeartbeat`; timeout evaluation subtracts `lastHeartbeat` from `now`; revocation persists `revokedAt` and may use `now` as provenance fallback for a generation that is already stale. An invalid absolute time can therefore poison durable worker state or make JavaScript comparison semantics silently skip a timeout.

The registry consequently validates caller-supplied absolute time before repository lookup, mutation, archive access, or liveness enumeration in:

- `register(..., now)`
- `heartbeat(..., now)`
- `listTimedOut(timeoutMs, now)`
- `revokeGeneration(..., now)`

An absolute time must be a non-negative finite number. `0` remains valid so deterministic tests and synthetic clocks do not need an artificial epoch offset. This contract does not introduce a monotonic-clock requirement: a finite non-negative timestamp earlier than a previous timestamp remains representable, because enforcing clock monotonicity is a separate policy decision from rejecting malformed numeric input.

Durations keep their existing contracts. In particular, heartbeat `timeoutMs` must remain a positive finite number; the absolute-time rule does not change that duration validation.

Validation is fail-closed. Invalid heartbeat or revocation time is rejected before active worker state or revoked-generation history changes, invalid registration time cannot create or replace a durable worker generation, and invalid liveness time is rejected before timeout selection begins.
