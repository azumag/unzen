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

Dispatcher configuration is validated at construction before any worker or routing state exists. Each numeric option is read from the caller-owned options object exactly once; the captured value is then used for default selection, validation, and stored dispatcher state. Optional numeric defaults are applied only when that captured value is `undefined`; an explicit `null` is treated as malformed runtime input and reaches the field-specific numeric validator instead of silently selecting a default.

This single-read boundary also applies to accessor- or Proxy-backed options. A getter cannot return a valid value during the default check and a different value during assignment, and constructor-side effects do not run twice merely because an explicit value was supplied.

- `loadBudgetRatio` must be finite and inside `(0, 1]`.
- `longLivedWorkerMs` must be finite and non-negative. Zero is valid and makes every otherwise-eligible worker immediately satisfy the age threshold.
- `configuredVramLimitMB` must be a JavaScript `number` at runtime and must be non-negative. Finite values impose a cap and positive infinity keeps the existing unlimited default. Only an omitted/`undefined` option selects that default; `null`, strings, booleans, objects, arrays, symbols, and other non-number values are rejected rather than coerced or treated as unlimited.
- `checkpointBytes` must be a positive finite number.

These guards keep `NaN`, invalid infinities, zero divisors, negative limits, and malformed runtime values out of VRAM-fit, lifetime, checkpoint-transfer, and score calculations. In particular, `configuredVramLimitMB` is checked for its runtime type before any numeric comparison, so values such as a `Symbol` cannot escape the canonical validation error through JavaScript coercion behavior.

## Segment configuration ownership

`segments` is copied into a dispatcher-owned frozen snapshot before its index and VRAM geometry is accepted. Scheduling, span-fit calculations, cache-hit range checks, and artifact-ledger compatibility all use that same validated snapshot. The caller may retain and mutate the original array or its segment objects, but those later mutations cannot change the dispatcher's routing geometry or introduce an unvalidated `estimatedVramMB` value after construction.

This matters because TypeScript `readonly` annotations do not prevent runtime mutation. Without a defensive snapshot, changing a validated `estimatedVramMB` to `NaN` after construction could make JavaScript fit comparisons fail open, while pushing or removing array entries could change assignment and cache-index ranges without rerunning constructor validation.

## Worker telemetry ownership

Every registration and heartbeat is copied into a dispatcher-owned frozen telemetry snapshot before validation and cache synchronization. The snapshot includes a copied/frozen `cacheHits` array and, when present, copied/frozen `cacheArtifacts` identity objects and array. Validation, residency synchronization, scoring, load gates, and stored worker state therefore all refer to the same accepted snapshot.

The snapshot boundary reads each telemetry root field used by the dispatcher exactly once. `cacheHits` and optional `cacheArtifacts` are first bound to one captured container reference; their top-level members are then copied by fixed numeric position before any cache-artifact identity field is read. Each identity's `segmentIndex` and `sha256` is captured exactly once and the owned identity is frozen from those captured primitives. Scalar telemetry fields are likewise captured once and the subsequent numeric validators operate only on those captured values.

This ordering matters for accessor- or Proxy-backed runtime input. A getter cannot return one collection during shape validation and a different collection during the copy, an early cache-artifact identity getter cannot replace a later array member before it is selected for validation, and a valid-first / altered-second identity getter cannot make the stored snapshot differ from the value whose runtime type was accepted. Collection membership is detached before scalar getters are evaluated, so a scalar getter that mutates the caller's cache arrays cannot retroactively change the accepted cache inventory.

Callers may retain and mutate their original telemetry object after `registerWorker()` or `updateHeartbeat()` returns, but those later writes cannot change accepted VRAM, busy ratios, failure rate, throughput, jitter, or cache claims without a new validated heartbeat. This closes the runtime gap between TypeScript `readonly` declarations and JavaScript object mutability, including the legacy index-only cache path.

## Runtime container shape

Snapshotting itself is also a runtime trust boundary. Before the dispatcher accepts telemetry-owned collections, it requires:

- the telemetry value to be a non-null, non-array object;
- the once-captured `cacheHits` value to be an actual JavaScript array;
- optional once-captured `cacheArtifacts` to be an actual JavaScript array when present;
- every captured `cacheArtifacts` member to be a non-null, non-array object;
- every cache-artifact `segmentIndex` to be a runtime `number` before normal range validation;
- every cache-artifact `sha256` to be a runtime `string` before canonical digest validation.

Container classification and every caller-owned property/array read needed to build that snapshot are bounded. Revoked Proxies fail through the same dispatcher-owned shape diagnostics instead of leaking native Proxy errors; throwing root fields, array length/index traps, identity fields, and scalar telemetry accessors are replaced with stable field-specific `could not be read` diagnostics. The value thrown by an accessor or trap is never inspected, stringified, or coerced, so its `Symbol.toPrimitive`, `valueOf`, or `toString` hooks are not executed by telemetry error handling.

After snapshotting, every `cacheHits` entry must also be a runtime JavaScript `number` before integer or segment-range checks. Non-number asserted or decoded values such as strings, objects, booleans, and `Symbol` values are rejected with an intentional dispatcher validation error without interpolating/coercing the untrusted value. Numeric values then continue through the existing non-negative integer and active segment-range contract.

These checks intentionally happen before defensive copying would otherwise re-read caller-owned fields, and before any untrusted cache-hit element is used in range-error formatting. As a result, asserted or decoded values such as `null`, primitive telemetry, iterable strings in `cacheHits`, object-shaped substitutes for arrays, malformed cache-artifact entries, non-string digest values, and non-number cache-hit entries are rejected by explicit validation rather than incidental spread/map/property/interpolation coercion failures. Numeric cache-index range checks, canonical SHA-256 checks, manifest identity checks, and duplicate detection still run afterward against the dispatcher-owned snapshot.

## Atomic heartbeat rule

`registerWorker()` snapshots and validates registration metadata and telemetry before synchronizing cache residency or inserting worker state. `updateHeartbeat()` snapshots and validates the entire telemetry object before synchronizing cache residency and before replacing the existing telemetry snapshot.

Therefore an invalid heartbeat:

1. throws before the new cache inventory is committed,
2. leaves the previous telemetry snapshot intact, and
3. leaves the previous cache-residency view intact.

Therefore a rejected re-registration also leaves the prior worker tier, telemetry snapshot, and cache-residency view unchanged because the replacement map write is after the entire telemetry snapshot/validation path.

This ordering is important because JavaScript comparisons with `NaN` are false. Without this boundary, `vramFreeMB = NaN` could bypass VRAM-fit checks and busy/failure ratios containing `NaN` could bypass load or health gates and contaminate ranking scores.

## Evidence scope

The tests exercise invalid registration metadata, rejected re-registration atomicity, invalid heartbeat atomicity, malformed telemetry container/collection shapes and cache-hit element types, revoked runtime containers, throwing telemetry/identity accessors, hostile thrown values with coercion hooks, valid telemetry boundaries, invalid dispatcher numeric configuration, explicit/defaulted numeric option single-read accessors, post-construction segment mutation isolation, post-acceptance telemetry mutation isolation, single-read collection/identity accessors, cache-artifact membership mutation during identity reads, and caller-cache mutation from scalar telemetry getters. Rejected malformed heartbeats and re-registrations are also checked to preserve the last-known-good routing and cache state. This is a coordinator contract guarantee only; it does not claim that browser-reported telemetry or tier classification is physically accurate or independently measured.
