# SpanRouter segment runtime envelope

`SpanRouter` treats `SegmentConfig[]` as a runtime trust boundary even though callers see a TypeScript interface. Segment metadata may come from decoded or asserted values, and residency-aware routing must not rely on JavaScript coercion or on downstream helpers to discover malformed data.

Before the router owns a snapshot or calls `ArtifactResidencyLedger.assertCompatibleSegments()`, every segment entry is validated as a non-null, non-array object. The router requires a non-negative safe-integer `index` equal to the array position, non-negative safe-integer `layerStart`, a safe-integer `layerEnd >= layerStart`, a non-empty string `modelWeightHash`, and a positive finite `estimatedVramMB`. Adjacent segment layer ranges must be contiguous.

Each consumed field is captured from the caller-owned segment exactly once, in validation order. Validation and the router-owned snapshot both use those captured primitive values. This prevents accessor- or Proxy-backed input from returning a valid value during validation and a different value when the snapshot is constructed. Capture remains staged rather than eagerly spreading the whole object, so an invalid early field fails before later accessors are touched.

The hash check intentionally validates only runtime shape and non-emptiness. Legacy prototype `SegmentConfig` values such as `sha256:seg-0` remain valid; cryptographic digest requirements belong to manifest-backed artifact validation rather than the generic router boundary.

The router creates a plain, frozen snapshot from the validated captured fields. Later caller mutation therefore cannot change VRAM accounting or geometry. Malformed metadata fails before manifest-backed residency compatibility logic, so values such as `Symbol` cannot reach string operations such as hash normalization.

This contract does not change worker ranking, cache-locality preference, route backtracking, resume semantics, or the existing behavior where an empty segment list produces an empty route. It is contract hardening for #167 and is not real-device/WebGPU evidence.
