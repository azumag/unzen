# ArtifactResidencyLedger artifact runtime envelope

`ArtifactResidencyLedger` accepts `SegmentArtifact[]` directly as well as through a validated model manifest. The direct constructor is therefore a runtime trust boundary: asserted, decoded, accessor-backed, or Proxy-backed values must not be able to make the stored artifact differ from the values that were validated.

For every top-level artifact, the ledger captures each consumed field only when validation reaches that field. The captured primitive is then used for both validation and construction of the frozen ledger-owned artifact. The caller-owned object is not spread into the stored value. This preserves fail-fast ordering: when an early field is invalid, unrelated later accessors are not evaluated.

Numeric fields are checked as numbers before integer/range comparisons; validation does not use `Number(...)`, `String(...)`, template coercion, or another user-defined conversion hook on an unvalidated value. Optional `encoding`, `components`, and `measurementConditions` remain absent from the stored object when omitted.

`compatibleRuntimes` is handled as a nested runtime boundary. The array reference is captured once, its initial length is fixed before any element getter runs, and every entry in that initial membership is captured once into an owned array before string validation. The final runtime list is frozen. A getter that mutates the caller-owned array cannot silently shrink the set of runtimes being validated.

Component bundles use the same ownership rule. The top-level `components` reference is captured once, the initial component count and positions are captured before any component field accessor runs, and each descriptor field (`role`, `path`, `byteSize`, `sha256`, `contentType`, and `artifactLocator`) is read once. Path uniqueness, graph identity, byte accounting, and the frozen stored descriptor all use those captured primitives. The implementation does not spread caller-owned component objects or coerce their byte sizes.

Fixing the initial component count also keeps array mutation fail-closed: if reading an earlier array element truncates the caller-owned bundle, a later position from the original membership becomes an invalid missing component rather than silently disappearing from validation.

This is runtime ownership hardening in support of #167. It does not constitute new real-model artifact materialization, physical WebGPU memory evidence, multi-browser relay measurements, or production deployment evidence.
