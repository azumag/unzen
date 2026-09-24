# Generated ONNX exact byte accounting

`importGeneratedOnnxSplitManifest()` treats generated graph and external-data byte counts as exact integers, not estimates.

For every generated segment:

- each declared byte count must already be a positive JavaScript safe integer;
- cumulative external-data bytes are checked against `Number.MAX_SAFE_INTEGER` **before** addition;
- graph bytes are derived only after that exact cumulative sum is known;
- an overflow is rejected with the existing `exceeds JavaScript safe integer range` diagnostic rather than allowing an IEEE-754 rounded intermediate value;
- browser artifact budget ceilings, path validation, digest validation, and manifest semantics are unchanged.

This keeps the importer aligned with the other exact-byte accounting boundaries in the manifest validator, artifact planner, and residency ledger. It is input-integrity hardening only and is not runtime/WebGPU evidence.
