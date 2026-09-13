# Segment artifact bundle runtime boundary

`canonicalSegmentArtifactBundleFields()` and `computeSegmentArtifactBundleDigest()` define the stable content identity for a logical multi-file browser segment artifact. Although their TypeScript signatures use `SegmentArtifactComponent[]`, generated JSON, asserted values, tests, and future import adapters can cross that type boundary at runtime.

The canonicalizer therefore validates the complete component envelope before it performs sorting or string operations. The top-level value must be a non-empty array, every entry must be an object, `role` must be `graph` or `external-data`, `path` / `contentType` / `artifactLocator` must be non-empty strings, `byteSize` must be a positive safe integer, and `sha256` must be a canonical lowercase 64-hex digest. Duplicate component paths are rejected and every bundle must contain exactly one graph component.

After validation, canonical ordering remains unchanged: the graph component sorts first and external-data components sort by path. Deployment locators are still deliberately excluded from the content digest, while the outer model manifest digest continues to bind locators. Valid manifests therefore retain their existing digest identity; only malformed runtime inputs fail earlier and with explicit bundle-contract errors.

This change is contract hardening for Issue #628 / #167. It does not provide new real-model artifact-size, physical WebGPU memory, multi-browser relay, latency, or worker-loss evidence.
