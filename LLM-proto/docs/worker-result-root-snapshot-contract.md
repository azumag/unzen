# Worker result root snapshot contract

`Pipeline` and `SpanPipeline` treat executor results as runtime-untrusted values even when TypeScript says the executor returns `SegmentResult` or `SpanResult`.

A worker may return an accessor- or Proxy-backed object whose root fields change between reads. Validation must therefore bind one attempt to one root envelope before type, identity, range, timing, checkpoint, or final-output checks begin.

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

## Failure boundary

A changed-on-second-read accessor is not allowed to repair an initially invalid identity or range. The first captured value is authoritative for that validation attempt. A contract violation keeps the existing failure behavior: the assigned worker is disconnected and normal bounded retry behavior applies.

This contract does not change final/non-final checkpoint/output rules, retry semantics, artifact-residency commit ordering, or the production evidence boundary for #167/#158.
