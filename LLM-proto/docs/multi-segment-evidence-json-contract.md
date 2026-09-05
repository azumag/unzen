# Multi-segment evidence JSON type contract

The #167 host-side capture and post-publication verifiers treat byte/count fields and artifact identity fields as immutable evidence, not as user-friendly CLI input.

## Exact JSON strings

The split manifest is an evidence contract, so artifact paths, digests, and tier labels must remain JSON strings. The artifact verifier does not normalize numbers or booleans with `str(...)`.

The following fields must be non-empty JSON strings:

- `split-manifest.segments[].path`
- `split-manifest.segments[].sha256`
- `split-manifest.segments[].browserArtifactTier`
- `split-manifest.segments[].externalData[].location`
- `split-manifest.segments[].externalData[].sha256`
- `split-manifest.browserArtifactBudget.segments[].tier`

SHA-256 fields additionally must be canonical lowercase 64-character hexadecimal strings. The split manifest must declare the exact supported `schemaVersion` (`1.0.0`); an unknown schema fails closed rather than being interpreted using the current verifier.

Published capture paths, SHA-256 identities, source external-data locations, and pass/fail statuses are likewise exact JSON string contracts in the bundle/source verifiers. For example, a 64-digit JSON integer is rejected even if converting it with `str(...)` would produce a syntactically valid SHA-256-shaped value.

## Exact JSON integers

The following fields must be JSON integers (`0`, `123`, ...), never floating-point values, booleans, or numeric strings.

### Split manifest artifact identity

- `split-manifest.segments[].index`
- `split-manifest.segments[].browserArtifactBytes`
- `split-manifest.segments[].externalData[].bytes`
- `split-manifest.splitPlan.requiredMaxBytes`
- `split-manifest.splitPlan.maximumGeneratedSegmentBytes`
- `split-manifest.browserArtifactBudget.preferredMaxBytes`
- `split-manifest.browserArtifactBudget.normalMaxBytes`
- `split-manifest.browserArtifactBudget.absoluteMaxBytes`
- `split-manifest.browserArtifactBudget.requiredMaxBytes`
- `split-manifest.browserArtifactBudget.maximumSegmentArtifactBytes`
- `split-manifest.browserArtifactBudget.segments[].index`
- `split-manifest.browserArtifactBudget.segments[].artifactBytes`

Positive budget/count fields must be greater than zero. Segment indices and measured byte counts may be zero only where the schema already permits zero.

### Published capture artifact identity

- `run-summary.artifacts.segmentCount`
- `run-summary.artifacts.maximumSegmentArtifactBytes`
- `run-summary.artifacts.effectiveRequiredMaxBytes`
- `same-machine-evidence.verification.artifactIntegrity.segmentCount`
- `same-machine-evidence.verification.artifactIntegrity.maximumSegmentArtifactBytes`
- `same-machine-evidence.verification.artifactIntegrity.effectiveRequiredMaxBytes`

These fields are cross-bound against the freshly measured artifact-integrity report and must retain their exact JSON integer type. For example, `2.0` is rejected even though Python would otherwise consider `2.0 == 2` true.

### Source artifact identity

- `split-manifest.sourceModel.externalData[].bytes`
- `same-machine-evidence.verification.sourceModel.graphBytes` when present
- `same-machine-evidence.verification.sourceModel.externalData[].bytes`

The verifiers intentionally do not coerce evidence values with `int(...)` or `str(...)`. Coercion can silently normalize malformed evidence; for example, JSON `12.9` becomes Python integer `12`, the numeric string `"12"` also becomes `12`, and an integer can become a plausible path or digest string. Such normalized values could then compare equal to measured filesystem identity and incorrectly pass an integrity audit.

Generated capture artifacts already emit these fields with their canonical JSON types, so valid bundles require no migration. A published bundle containing a float, boolean, numeric string, or non-string identity in one of these fields is rejected fail-closed and should be regenerated rather than edited in place.

Run the bundle audit with:

```bash
python tools/verify_multi_segment_capture_bundle.py \
  --capture-dir /absolute/path/to/capture
```

Run the source audit with:

```bash
python tools/verify_multi_segment_capture_source.py \
  --capture-dir /absolute/path/to/capture \
  --full-model /absolute/path/to/model_q4.onnx
```

A successful audit still means only that the published capture, generated artifacts, and supplied source files are cryptographically and structurally consistent. It does not upgrade a failed numerical comparison to a passing one and does not replace the real multi-browser WebGPU evidence required by #167.
