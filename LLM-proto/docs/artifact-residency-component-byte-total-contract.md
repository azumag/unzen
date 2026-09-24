# Artifact residency component-byte total contract

Tracking: #1642. Parent technical-core work: #167.

Direct `ArtifactResidencyLedger` construction validates component bundles independently of the model-manifest validator. Component `byteSize` values are individually positive safe integers, and their cumulative total is also exact byte accounting: before each addition, the ledger rejects a value that would push the sum beyond `Number.MAX_SAFE_INTEGER`.

The existing diagnostic remains `segment N component bytes exceed JavaScript safe integer range`. This check happens before a rounded sum can reach the canonical bundle grammar or the final `componentBytes === artifact.byteSize` comparison.

For accepted bundles, path uniqueness, exactly-one-graph, primary graph locator binding, digest/content-type validation, and equality between component bytes and top-level artifact bytes remain unchanged.
