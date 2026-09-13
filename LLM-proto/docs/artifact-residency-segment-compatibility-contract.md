# ArtifactResidencyLedger segment compatibility runtime contract

`ArtifactResidencyLedger.assertCompatibleSegments()` is a public runtime boundary. TypeScript callers normally provide `SegmentConfig[]`, but asserted or deserialized values can reach the method directly without passing through `SpanRouter` or `AdaptiveChunkDispatcher` validation.

## Contract

Before count, map, string, or numeric compatibility operations run:

- `segments` must be an array
- every segment must be a non-null, non-array object
- `index` must be a non-negative safe integer
- `layerStart` must be a non-negative safe integer
- `layerEnd` must be a safe integer greater than or equal to `layerStart`
- `modelWeightHash` must be a non-empty string
- `estimatedVramMB` must be a positive finite number

The ledger validates every entry into an owned frozen snapshot before comparing that snapshot with its immutable artifact inventory. Rejected compatibility input does not modify worker residency state.

## Preserved compatibility semantics

This boundary does not change model compatibility policy:

- segment count must still equal artifact count
- all artifact indexes must still be represented
- `modelWeightHash` comparison remains case-insensitive against the canonical artifact SHA-256 value
- layer geometry must still exactly match the artifact inventory
- estimated VRAM must still exactly match `estimatedMemoryMB`

The validator deliberately does not require array-order indexes or add a stricter hash syntax because those would change the existing public compatibility semantics.

This is runtime trust-boundary hardening only. It is not evidence of real WebGPU execution, physical GPU memory use, multi-browser relay latency, or worker-loss resume behavior.
