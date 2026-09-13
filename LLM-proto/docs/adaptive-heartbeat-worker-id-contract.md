# AdaptiveChunkDispatcher heartbeat worker-ID runtime contract

`AdaptiveChunkDispatcher.updateHeartbeat()` is a runtime boundary even though its TypeScript signature accepts the branded `WorkerId` type. Asserted or decoded runtime data can bypass that compile-time brand.

## Contract

1. The heartbeat worker identity is validated with the shared `workerId()` contract before worker-map lookup, unknown-worker diagnostic formatting, telemetry inspection, or cache-residency synchronization.
2. IDs must be actual non-empty strings. Empty/whitespace strings, numbers, objects, arrays, `null`, and symbols fail deterministically with the worker-ID validation error.
3. Valid non-empty string IDs are preserved exactly; the dispatcher does not trim or rewrite identity.
4. A valid ID that is not registered keeps the existing `Unknown adaptive worker: <id>` behavior. Telemetry is not inspected for an unknown worker.
5. For a registered worker, telemetry snapshot/validation and manifest-backed residency synchronization retain their existing ordering and atomicity guarantees.

A rejected heartbeat therefore cannot mutate the worker's last-known-good telemetry, in-memory resident segment set, or manifest-backed residency snapshot.

## Non-goals

This change does not alter telemetry ranges, heartbeat scheduling, worker registration/reconnect policy, adaptive scoring, cache policy, or deployment behavior.

Related: #582, #580, #167, `adaptive-worker-telemetry-contract.md`.
