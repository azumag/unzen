# Adaptive worker telemetry contract

`AdaptiveChunkDispatcher` treats worker telemetry and registration metadata as untrusted coordinator-side input. Runtime validation happens before worker state or artifact-residency state is mutated, so malformed or corrupted registrations/heartbeats cannot make a worker appear healthier or more capable than its last known-good state.

## Numeric domain

The following fields must be finite and non-negative:

- `uptimeMs`
- `vramFreeMB`
- `tokensPerSecond`
- `checkpointBytesPerSecond`
- `heartbeatJitterMs`

The following ratios must be finite and inside `[0, 1]`:

- `gpuBusyRatio`
- `cpuBusyRatio`
- `failureRate`

Zero throughput is intentionally valid. In particular, `checkpointBytesPerSecond = 0` remains a valid observation and produces an infinite checkpoint-transfer estimate instead of inventing throughput.

## Worker registration metadata

`registerWorker()` accepts only the three runtime tier values defined by `WorkerTier`: `TIER_1`, `TIER_2`, and `TIER_3`. The TypeScript enum is not treated as runtime validation because network/deserialized callers can still supply arbitrary values.

Tier validation happens before telemetry validation, cache-residency synchronization, or worker-map replacement. This prevents an invalid tier from falling through the non-Tier-3 routing paths and gaining multi-segment or rolling-assignment eligibility. It also means a rejected re-registration cannot replace an existing valid worker's tier, telemetry, or cache state.

## Dispatcher numeric configuration

Dispatcher configuration is validated at construction before any worker or routing state exists. Optional numeric defaults are applied only when the field is omitted or explicitly `undefined`; an explicit `null` is treated as malformed runtime input and reaches the field-specific numeric validator instead of silently selecting a default.

- `loadBudgetRatio` must be finite and inside `(0, 1]`.
- `longLivedWorkerMs` must be finite and non-negative. Zero is valid and makes every otherwise-eligible worker immediately satisfy the age threshold.
- `configuredVramLimitMB` must be a JavaScript `number` at runtime and must be non-negative. Finite values impose a cap and positive infinity keeps the existing unlimited default. Only an omitted/`undefined` option selects that default; `null`, strings, booleans, objects, arrays, symbols, and other non-number values are rejected rather than coerced or treated as unlimited.
- `checkpointBytes` must be a positive finite number.

These guards keep `NaN`, invalid infinities, zero divisors, negative limits, and malformed runtime values out of VRAM-fit, lifetime, checkpoint-transfer, and score calculations. In particular, `configuredVramLimitMB` is checked for its runtime type before any numeric comparison, so values such as a `Symbol` cannot escape the canonical validation error through JavaScript coercion behavior.

## Segment configuration ownership

`segments` is copied into a dispatcher-owned frozen snapshot before its index and VRAM geometry is accepted. Scheduling, span-fit calculations, cache-hit range checks, and artifact-ledger compatibility all use that same validated snapshot. The caller may retain and mutate the original array or its segment objects, but those later mutations cannot change the dispatcher's routing geometry or introduce an unvalidated `estimatedVramMB` value after construction.

This matters because TypeScript `readonly` annotations do not prevent runtime mutation. Without a defensive snapshot, changing a validated `estimatedVramMB` to `NaN` after construction could make JavaScript fit comparisons fail open, while pushing or removing array entries could change assignment and cache-index ranges without rerunning constructor validation.

## Atomic heartbeat rule

`registerWorker()` validates registration metadata and telemetry before synchronizing cache residency or inserting worker state. `updateHeartbeat()` validates the entire telemetry object before synchronizing cache residency and before replacing the existing telemetry snapshot.

Therefore an invalid heartbeat:

1. throws before the new cache inventory is committed,
2. leaves the previous telemetry snapshot intact, and
3. leaves the previous cache-residency view intact.

This ordering is important because JavaScript comparisons with `NaN` are false. Without this boundary, `vramFreeMB = NaN` could bypass VRAM-fit checks and busy/failure ratios containing `NaN` could bypass load or health gates and contaminate ranking scores.

## Evidence scope

The tests exercise invalid registration metadata, rejected re-registration atomicity, invalid heartbeat atomicity, valid telemetry boundaries, invalid dispatcher numeric configuration, and post-construction segment mutation isolation. This is a coordinator contract guarantee only; it does not claim that browser-reported telemetry or tier classification is physically accurate or independently measured.
