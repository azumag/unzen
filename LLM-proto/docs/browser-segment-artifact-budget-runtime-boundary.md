# Browser segment artifact budget runtime boundary

`evaluateBrowserSegmentArtifactBytes()` classifies measured browser shard sizes against the preferred, normal, degraded, and rejected byte ceilings. Its TypeScript `number` parameter is not a runtime guarantee: generated manifests, decoded metadata, tests, or JavaScript callers can still pass asserted values of another type.

The evaluator therefore establishes `typeof byteSize === 'number'` before any integer/range checks and before diagnostic formatting. Invalid values fail with the same intentional `positive safe integer` contract without coercing the untrusted value. In particular, `Symbol` must not escape as an incidental `TypeError: Cannot convert a Symbol value to a string`.

`evaluateBrowserSegmentArtifact()` is the canonical bridge from runtime `SegmentArtifact.byteSize` data into that byte policy. It accepts only a non-array object, captures `.byteSize` exactly once, and delegates the captured value to `evaluateBrowserSegmentArtifactBytes()`. This matters for decoded/asserted or accessor-backed objects: a changed-on-second-read getter must not provide one size for validation and another for classification. Keeping the numeric thresholds in the raw-byte evaluator also avoids a second copy of the target/preferred/normal/absolute policy.

Both entry points return the same runtime-frozen policy snapshot. TypeScript `readonly` alone does not prevent JavaScript callers or casts from rewriting `tier`, `usable`, or the policy thresholds after evaluation, so `Object.freeze()` reinforces the ownership boundary. Callers may retain or pass the result onward without being able to mutate the evaluator's classification in place.

Accepted semantics are unchanged: byte sizes must be positive safe integers; existing preferred/normal/degraded/rejected thresholds and the `usable` result are unaffected. Regression coverage in `tests/browser-segment-artifact-budget.test.ts` includes direct `SegmentArtifact.byteSize` evaluation, changed-on-second-read accessors, malformed object inputs, and the existing threshold boundary cases.

This is structural contract hardening for the #167 artifact-budget path and closes #1264. It does not provide new evidence for real Llama-3.2-1B q4 materialization, physical WebGPU memory use, multi-browser relay, or worker-loss recovery.
