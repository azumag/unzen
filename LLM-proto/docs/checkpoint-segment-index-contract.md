# Checkpoint segment-index numeric contract

Tracking: #447, #507. Parent technical-core work: #167.

## Trust boundary

`CheckpointStore` uses a JavaScript `number` as the per-request checkpoint map key and compares segment indexes when selecting the latest durable resume point. Segment identity therefore needs exact integer semantics.

A checkpoint may enter the store only when `segmentIndex` satisfies:

```text
Number.isSafeInteger(segmentIndex)
segmentIndex >= 0
```

This rejects values above `Number.MAX_SAFE_INTEGER`, where distinct mathematical integers can collapse to the same JavaScript `number`. Validation happens before any request map is created or mutated.

`get(requestId, segmentIndex)` applies the same non-negative safe-integer contract before reading the per-request checkpoint map. A malformed lookup (`NaN`, fractional, negative, or unsafe integer) is therefore rejected instead of being silently converted into the same `undefined` result as a well-formed but absent checkpoint. Valid non-negative safe-integer lookup semantics are unchanged.

The optional `latest(requestId, atOrBeforeSegmentIndex)` upper bound follows exact safe-integer semantics but intentionally has different range behavior: unsafe or non-integral bounds throw before the checkpoint map is scanned, while a negative **safe integer** remains a valid empty range and returns `undefined`, preserving the existing API behavior.

## Scope

This contract applies to the in-memory prototype `CheckpointStore` used by the legacy pipeline tests. It does not claim Durable Object persistence, distributed worker-loss recovery, real-browser checkpoint transport, or WebGPU evidence. Those remain separate #167 concerns.
