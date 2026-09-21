# Artifact residency component path safety

`ArtifactResidencyLedger` is a runtime trust boundary even when it is constructed directly from a typed `SegmentArtifact[]`. JavaScript callers can still supply asserted, decoded, accessor-backed, or otherwise untrusted values without first passing through the full model-manifest validator.

For a multi-file segment bundle, direct construction therefore uses the same component path grammar as the canonical model-manifest bundle boundary. Every component path must be a relative POSIX path: it must not begin with `/`, contain `\\`, contain an empty path component, or contain `.` or `..` components. Nested paths such as `weights/chunk-0.bin` remain valid.

The ledger first captures and validates each caller-owned component field into an owned frozen descriptor. It then applies the canonical bundle grammar to those owned copies. This preserves the existing single-read protection against accessors or proxies changing a component after validation while preventing direct construction from accepting a weaker artifact identity than `ArtifactResidencyLedger.fromManifest()`.

The existing invariants remain unchanged: component paths are unique, the bundle contains exactly one graph, the graph locator matches the segment's primary locator, component byte totals equal the segment byte size, and the browser artifact budget gate remains in force.

This is runtime artifact-identity hardening only. It does not constitute new real-model, physical WebGPU, multi-browser relay, or worker-loss/resume evidence for #167.
