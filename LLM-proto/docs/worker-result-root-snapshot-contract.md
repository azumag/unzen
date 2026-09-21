# Worker result root snapshot contract

`Pipeline` and `SpanPipeline` treat executor results as runtime-untrusted values even when TypeScript says the executor returns `SegmentResult` or `SpanResult`.

A worker may return an accessor- or Proxy-backed object whose root fields change between reads. Validation must therefore bind one attempt to one root envelope before type, identity, range, timing, checkpoint, or final-output checks begin.

## Runtime record boundary

Top-level result classification is itself part of the trust boundary. `Array.isArray()` may throw for a revoked Proxy, so both pipelines perform that check inside a bounded guard. A revoked root therefore fails through the existing `segment result must be a non-null, non-array object` / `span result must be a non-null, non-array object` diagnostic instead of leaking a native Proxy exception.

Once a result is accepted as a record, every declared root field is read at most once. If a field getter or Proxy trap throws, the thrown value is neither inspected nor coerced; a stable invalid sentinel is captured instead and the existing field-type or final/non-final validation rejects it. This prevents error handling from executing hostile `toString()` or `Symbol.toPrimitive` hooks.

## Single-segment Pipeline

After verifying that the executor result is a non-null, non-array object, validation captures these root fields exactly once:

- `requestId`
- `segmentIndex`
- `workerId`
- `processingTimeMs`
- `checkpoint`
- `output`

All subsequent type checks, assignment comparisons, diagnostics, checkpoint validation, and final-output validation consume only the captured values. In particular, a field cannot return one value for a type check and another value for an identity/range comparison.

## SpanPipeline

The span result boundary similarly captures exactly once:

- `requestId`
- `workerId`
- `startSegment`
- `endSegment`
- `processingTimeMs`
- `checkpoint`
- `output`

The captured checkpoint/output references are the same references passed into the nested checkpoint or final-output snapshot validator. There is no second root dereference after the snapshot.

## Lazy checkpoint and metadata boundary

Checkpoint and metadata records are also classified with bounded `Array.isArray()` checks. Revoked checkpoint or metadata proxies become stable invalid values that are rejected by the existing pipeline/checkpoint taxonomy.

Nested checkpoint fields remain lazy and memoized. Constructing the root snapshot does not eagerly read `checkpoint.requestId`, `segmentIndex`, `hiddenStates`, metadata, shape, or other nested accessors. This preserves final-result short-circuit behavior: a forbidden checkpoint on a final result can be rejected before hostile nested fields are touched. When a nested field is first consumed, its getter/trap is invoked at most once and any failure is captured as a stable invalid value.

Checkpoint `metadata.shape` is copied without caller iteration. The `Array.isArray()` check, `length` read, and three canonical numeric-index reads are independently bounded. Revoked shape proxies or throwing length/index traps collapse to an owned invalid-shape snapshot, while valid rank-3 shapes are copied into an owned frozen array.

## Failure boundary

A changed-on-second-read accessor is not allowed to repair an initially invalid identity or range. The first captured value is authoritative for that validation attempt. A contract violation keeps the existing failure behavior: the assigned worker is disconnected and normal bounded retry behavior applies.

This contract does not change final/non-final checkpoint/output rules, retry semantics, artifact-residency commit ordering, or the production evidence boundary for #167/#158.
