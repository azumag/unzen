# Browser segment artifact budget runtime boundary

`evaluateBrowserSegmentArtifactBytes()` is used to classify measured browser shard sizes against the preferred, normal, degraded, and rejected byte ceilings. Its TypeScript `number` parameter is not a runtime guarantee: generated manifests, decoded metadata, tests, or JavaScript callers can still pass asserted values of another type.

The evaluator therefore establishes `typeof byteSize === 'number'` before any integer/range checks and before diagnostic formatting. Invalid values fail with the same intentional `positive safe integer` contract without coercing the untrusted value. In particular, `Symbol` must not escape as an incidental `TypeError: Cannot convert a Symbol value to a string`.

Accepted semantics are unchanged: byte sizes must be positive safe integers; existing preferred/normal/degraded/rejected thresholds and the `usable` result are unaffected. Regression coverage is in `tests/browser-segment-artifact-budget.test.ts`.

This is structural contract hardening for the #167 artifact-budget path. It does not provide new evidence for real Llama-3.2-1B q4 materialization, physical WebGPU memory use, multi-browser relay, or worker-loss recovery.
