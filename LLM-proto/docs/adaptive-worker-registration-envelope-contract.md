# AdaptiveChunkDispatcher worker registration runtime envelope

`AdaptiveChunkDispatcher.registerWorker()` is a public runtime boundary. Although TypeScript callers normally provide `AdaptiveWorkerRegistration`, asserted, decoded, accessor-backed, proxied, or otherwise runtime-originated values may still reach the method.

## Contract

Registration is validated before worker or cache-residency state can change:

1. The top-level registration must be a non-null, non-array object. Primitives, arrays, functions, `null`, and `undefined` are rejected before any registration field is read.
2. `id` continues to use the shared `workerId()` contract: it must be an actual non-empty string. The value is not trimmed or rewritten.
3. `tier` is captured exactly once, then that same captured value must be one of the closed `WorkerTier` values (`TIER_1`, `TIER_2`, `TIER_3`) and is the value stored in worker state. Tier validation occurs before telemetry snapshotting or cache synchronization.
4. `telemetry` is snapshotted into dispatcher-owned immutable arrays/objects and then validated using the existing adaptive telemetry contract.
5. Manifest-backed cache residency is synchronized only after the registration container, worker ID, captured tier, telemetry shape, telemetry values, cache indexes, and cache artifact identities have all passed validation.
6. The worker map is replaced only after cache validation/synchronization succeeds.

The registration envelope itself is a bounded runtime read. Root object/array classification tolerates revoked Proxies, and `id`, `tier`, and `telemetry` are each captured exactly once through dispatcher-owned guarded reads. If a getter or Proxy trap throws, the dispatcher replaces that failure with a stable field-specific `adaptive worker registration ... could not be read` diagnostic. The thrown value is never inspected, stringified, or coerced, so caller-controlled `Symbol.toPrimitive`, `valueOf`, and `toString` hooks are not executed by this boundary.

Invalid tier diagnostics follow the same trust-boundary rule after a `tier` value has been read successfully. Primitive invalid values keep useful diagnostics (`0`, `4`, strings, `null`, `undefined`, and symbols where safely representable), while object/function values are rendered as the dispatcher-owned token `unknown`. Tier diagnostics never invoke caller-controlled `Symbol.toPrimitive`, `valueOf`, or `toString` hooks. This diagnostic hardening does not alter the closed accepted tier set or the validation/mutation order.

Rejected registrations therefore cannot create a worker, replace an existing valid worker, or clear/replace that worker's last known-good manifest-backed cache residency. Accessor- or Proxy-backed registrations also cannot return one valid ID, tier, or telemetry object for validation and a different value for storage in the same registration attempt.

## Preserved behavior

This hardening does not change valid registration semantics, worker ID semantics, worker tier/scoring policy, telemetry ranges, cache identity rules, or valid re-registration replacement behavior. It only makes the TypeScript registration interface an explicit runtime trust boundary.

Related: #580, #686, #1432, #1434, #1436, #167, `adaptive-worker-telemetry-contract.md`.
