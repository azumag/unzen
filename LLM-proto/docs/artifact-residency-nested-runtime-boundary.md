# Artifact residency nested runtime boundary

`ArtifactResidencyLedger` treats artifact manifests, compatibility configs, component records, and their nested arrays as caller-owned runtime input even when TypeScript types say otherwise. JavaScript callers can supply revoked proxies, throwing accessors, or array proxies whose `length` or numeric-index reads throw.

The ledger therefore validates nested residency input with an operation-local snapshot discipline:

- artifact, `SegmentConfig`, and component records are shape-checked without allowing a revoked Proxy exception to escape;
- every consumed record field is read once through a bounded accessor, and a throwing getter maps to the same ledger-owned validation diagnostic used for an invalid value;
- thrown values are never stringified or coerced while handling the failure;
- `components` and `compatibleRuntimes` are copied by one bounded `length` read plus numeric-index reads, without invoking `Symbol.iterator`;
- component records are validated only after the caller-owned component-array membership snapshot succeeds;
- the ledger stores only newly created frozen artifact/config/component values, so later caller mutation cannot alter residency identity or compatibility decisions.

Validation remains fail-fast in the existing field order. Valid runtime inputs, artifact-budget semantics, segment geometry, cache behavior, model formats, and public result schemas are unchanged.

This is runtime and residency reliability hardening only. It is not new evidence for real-model execution, physical WebGPU support, distinct-browser relay/latency, worker-loss recovery, or measured long-lived artifact residency.
