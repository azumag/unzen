# ArtifactResidencyLedger artifact runtime envelope

`ArtifactResidencyLedger` accepts `SegmentArtifact[]` directly as well as through a validated model manifest. The direct constructor is therefore a runtime trust boundary: asserted, decoded, accessor-backed, or Proxy-backed values must not be able to make the stored artifact differ from the values that were validated.

For every top-level artifact, the ledger captures each consumed field only when validation reaches that field. The captured primitive is then used for both validation and construction of the frozen ledger-owned artifact. The caller-owned object is not spread into the stored value. This preserves fail-fast ordering: when an early field is invalid, unrelated later accessors are not evaluated.

Numeric fields are checked as numbers before integer/range comparisons; validation does not use `Number(...)`, `String(...)`, template coercion, or another user-defined conversion hook on an unvalidated value. Optional `encoding`, `components`, and `measurementConditions` remain absent from the stored object when omitted.

`compatibleRuntimes` is handled as a nested runtime boundary. The array reference is captured once, its initial length is fixed before any element getter runs, and every entry in that initial membership is captured once into an owned array before string validation. The final runtime list is frozen. A getter that mutates the caller-owned array cannot silently shrink the set of runtimes being validated.

Component descriptors retain their existing bundle-validation contract. The top-level `components` reference is captured once and handed to component validation through an owned artifact envelope, so root artifact accessors are not reread. Component-level accessor hardening is a separate boundary and should be handled independently if needed.

This is runtime ownership hardening in support of #167. It does not constitute new real-model artifact materialization, physical WebGPU memory evidence, multi-browser relay measurements, or production deployment evidence.
