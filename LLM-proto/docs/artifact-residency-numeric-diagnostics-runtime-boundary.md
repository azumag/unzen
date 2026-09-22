# ArtifactResidencyLedger numeric diagnostic runtime boundary

`ArtifactResidencyLedger` is callable from JavaScript even though its public numeric arguments are typed. Rejected values passed to `getArtifact(segmentIndex)` and the range-based APIs (`markResidentRange`, `residentArtifactBytes`, `artifactBytes`, `missingArtifacts`, and `missingArtifactBytes`) therefore remain runtime trust boundaries.

Validation still uses the existing lookup and range rules. Only failure formatting changes: primitive values retain useful text, while object and function values are reported as `unknown` without invoking caller-owned `Symbol.toPrimitive`, `valueOf`, or `toString` hooks. Symbols are formatted with JavaScript's safe primitive conversion and revoked proxies never need to be inspected.

Range validation still completes before `markResidentRange` creates or mutates worker residency state, so an invalid caller value cannot leave a partially committed cache observation. Artifact byte accounting, routing semantics, segment geometry, and public API shape are unchanged.

Focused regressions live in `tests/artifact-residency-numeric-diagnostics.test.ts` and cover hostile object/function values, symbols, revoked proxies, primitive diagnostics, and zero residency mutation on a failed range update.

This is reliability/trust-boundary hardening only. It is not new real-model, physical WebGPU, distinct-browser relay/latency, worker-loss/resume, or artifact-residency execution evidence for #167.
