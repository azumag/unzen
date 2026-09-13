# AdaptiveChunkDispatcher worker registration runtime envelope

`AdaptiveChunkDispatcher.registerWorker()` is a public runtime boundary. Although TypeScript callers normally provide `AdaptiveWorkerRegistration`, asserted, decoded, or otherwise runtime-originated values may still reach the method.

## Contract

Registration is validated before worker or cache-residency state can change:

1. The top-level registration must be a non-null, non-array object. Primitives, arrays, functions, `null`, and `undefined` are rejected before any registration field is read.
2. `id` continues to use the shared `workerId()` contract: it must be an actual non-empty string. The value is not trimmed or rewritten.
3. `tier` must be one of the closed `WorkerTier` values (`TIER_1`, `TIER_2`, `TIER_3`). Tier validation occurs before telemetry snapshotting or cache synchronization.
4. `telemetry` is snapshotted into dispatcher-owned immutable arrays/objects and then validated using the existing adaptive telemetry contract.
5. Manifest-backed cache residency is synchronized only after the registration container, worker ID, tier, telemetry shape, telemetry values, cache indexes, and cache artifact identities have all passed validation.
6. The worker map is replaced only after cache validation/synchronization succeeds.

Rejected registrations therefore cannot create a worker, replace an existing valid worker, or clear/replace that worker's last known-good manifest-backed cache residency.

## Preserved behavior

This hardening does not change valid registration semantics, worker tier/scoring policy, telemetry ranges, cache identity rules, or valid re-registration replacement behavior. It only makes the TypeScript registration interface an explicit runtime trust boundary.

Related: #580, #167, `adaptive-worker-telemetry-contract.md`.