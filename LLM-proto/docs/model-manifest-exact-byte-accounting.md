# Model manifest exact-byte accounting

`SegmentArtifact.byteSize` and every `components[].byteSize` are exact byte counts, not approximate telemetry.

The manifest validator therefore accepts these values only as positive JavaScript safe integers. When an artifact has component descriptors, their cumulative byte count must also remain within `Number.MAX_SAFE_INTEGER`. Validation checks the remaining component structure even after the total can no longer be represented exactly, but it does not perform or report an imprecise cumulative addition.

If adding a valid component byte size would exceed `Number.MAX_SAFE_INTEGER`, validation fails closed with `artifact-component-byte-size-mismatch` at the artifact's `components` path. The accumulated total is then treated as unavailable, so the normal `component bytes total ... does not match artifact byteSize ...` diagnostic is not produced from a rounded IEEE-754 value.

For totals that remain inside the safe-integer range, existing behavior is unchanged: the exact component sum must equal the artifact's declared `byteSize`. Per-component failures continue to use `invalid-artifact-component-byte-size` and are independent of the cumulative-total guard.

This boundary is intentionally aligned with the browser artifact planner/verifier exact-byte contract. It does not represent runtime performance evidence or change model artifact budgets.
