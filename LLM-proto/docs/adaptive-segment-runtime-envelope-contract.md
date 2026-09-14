# AdaptiveChunkDispatcher segment runtime envelope

`AdaptiveChunkDispatcher` accepts segment configuration through a TypeScript interface, but callers may still supply asserted, deserialized, accessor-backed, proxied, or otherwise runtime-originated values. The constructor therefore treats both the top-level options value and `segments` as an untrusted runtime boundary.

## Contract

The dispatcher binds construction to one caller-observed segment container and one detached top-level membership snapshot before it reads any segment fields or allows `ArtifactResidencyLedger.assertCompatibleSegments()` to inspect the resulting configuration.

- top-level options must be a non-null, non-array object
- `options.segments` is captured exactly once
- the captured `segments` value must be an array and must remain non-empty
- array length and every top-level segment reference are captured by fixed numeric position before any segment field is read
- caller-overridden iteration is not used to capture segment membership
- every captured segment must be a non-null, non-array object
- `index` must be a non-negative safe integer and equal its array position
- `layerStart` must be a non-negative safe integer
- `layerEnd` must be a safe integer greater than or equal to `layerStart`
- adjacent segment layer ranges must be contiguous
- `modelWeightHash` must be a non-empty string
- `estimatedVramMB` must be a positive finite number

After membership capture, validation proceeds in array order and the dispatcher stores frozen plain-object segment snapshots. A getter on an earlier segment therefore cannot replace a later caller-owned array slot and cause a different segment object to enter the same constructor operation. Later caller mutation likewise cannot change routing geometry, cache-hit range validation, or manifest-backed compatibility decisions.

## Compatibility

The runtime boundary deliberately does not narrow `modelWeightHash` to a canonical digest syntax. Existing prototype values such as `sha256:seg-0` remain valid. Per-segment validation order, contiguous-range checks, load/VRAM/checkpoint option semantics, adaptive scoring/routing policy, and ledger compatibility checks are unchanged.

This contract is a coordinator/runtime hardening measure. It is not evidence of real-device WebGPU execution, physical GPU memory use, multi-browser relay latency, or worker-loss resume behavior.
