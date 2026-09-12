# Adaptive worker telemetry contract

`AdaptiveChunkDispatcher` treats worker telemetry as an untrusted coordinator-side input. Runtime validation happens before worker state or artifact-residency state is mutated, so malformed or corrupted heartbeats cannot make a worker appear healthier or more capable than its last known-good state.

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

## Dispatcher numeric configuration

Dispatcher configuration is validated at construction before any worker or routing state exists:

- `loadBudgetRatio` must be finite and inside `(0, 1]`.
- `longLivedWorkerMs` must be finite and non-negative. Zero is valid and makes every otherwise-eligible worker immediately satisfy the age threshold.
- `configuredVramLimitMB` must be non-negative; finite values impose a cap and positive infinity keeps the existing unlimited default.
- `checkpointBytes` must be a positive finite number.

These guards keep `NaN`, invalid infinities, zero divisors, and negative limits out of VRAM-fit, lifetime, checkpoint-transfer, and score calculations.

## Atomic heartbeat rule

`registerWorker()` validates telemetry before synchronizing cache residency or inserting worker state. `updateHeartbeat()` validates the entire telemetry object before synchronizing cache residency and before replacing the existing telemetry snapshot.

Therefore an invalid heartbeat:

1. throws before the new cache inventory is committed,
2. leaves the previous telemetry snapshot intact, and
3. leaves the previous cache-residency view intact.

This ordering is important because JavaScript comparisons with `NaN` are false. Without this boundary, `vramFreeMB = NaN` could bypass VRAM-fit checks and busy/failure ratios containing `NaN` could bypass load or health gates and contaminate ranking scores.

## Evidence scope

The tests exercise invalid registration, invalid heartbeat atomicity, valid telemetry boundaries, and invalid dispatcher numeric configuration. This is a coordinator contract guarantee only; it does not claim that browser-reported telemetry is physically accurate or independently measured.