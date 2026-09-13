# AdaptiveChunkDispatcher segment runtime envelope

`AdaptiveChunkDispatcher` accepts segment configuration through a TypeScript interface, but callers may still supply asserted, deserialized, or otherwise runtime-originated values. The constructor therefore treats both the top-level options value and `segments` as an untrusted runtime boundary.

## Contract

Validation happens before the dispatcher creates its owned segment snapshot and before `ArtifactResidencyLedger.assertCompatibleSegments()` is allowed to inspect segment fields.

- top-level options must be a non-null, non-array object
- `segments` must be an array and must remain non-empty
- every segment must be a non-null, non-array object
- `index` must be a non-negative safe integer and equal its array position
- `layerStart` must be a non-negative safe integer
- `layerEnd` must be a safe integer greater than or equal to `layerStart`
- adjacent segment layer ranges must be contiguous
- `modelWeightHash` must be a non-empty string
- `estimatedVramMB` must be a positive finite number

After validation, the dispatcher stores a frozen plain-object snapshot. Later caller mutation therefore cannot change routing geometry, cache-hit range validation, or manifest-backed compatibility decisions.

## Compatibility

The runtime boundary deliberately does not narrow `modelWeightHash` to a canonical digest syntax. Existing prototype values such as `sha256:seg-0` remain valid. Load/VRAM/checkpoint option semantics and adaptive scoring/routing policy are unchanged.

This contract is a coordinator/runtime hardening measure. It is not evidence of real-device WebGPU execution, physical GPU memory use, multi-browser relay latency, or worker-loss resume behavior.
