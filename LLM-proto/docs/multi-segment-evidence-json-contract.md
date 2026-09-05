# Multi-segment evidence JSON type contract

The #167 host-side capture and post-publication verifiers treat byte/count fields as immutable evidence, not as user-friendly CLI input.

The following fields must therefore be JSON integers (`0`, `123`, ...), never floating-point values, booleans, or numeric strings.

## Split manifest artifact identity

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

## Published capture artifact identity

- `run-summary.artifacts.segmentCount`
- `run-summary.artifacts.maximumSegmentArtifactBytes`
- `run-summary.artifacts.effectiveRequiredMaxBytes`
- `same-machine-evidence.verification.artifactIntegrity.segmentCount`
- `same-machine-evidence.verification.artifactIntegrity.maximumSegmentArtifactBytes`
- `same-machine-evidence.verification.artifactIntegrity.effectiveRequiredMaxBytes`

These fields are cross-bound against the freshly measured artifact-integrity report and must retain their exact JSON integer type. For example, `2.0` is rejected even though Python would otherwise consider `2.0 == 2` true.

## Source artifact identity

- `split-manifest.sourceModel.externalData[].bytes`
- `same-machine-evidence.verification.sourceModel.graphBytes` when present
- `same-machine-evidence.verification.sourceModel.externalData[].bytes`

The verifiers intentionally do not coerce evidence values with `int(...)`. Coercion can silently normalize malformed evidence; for example, JSON `12.9` becomes Python integer `12`, and the numeric string `"12"` also becomes `12`. Either could then compare equal to a measured 12-byte file and incorrectly pass an integrity audit.

Generated capture artifacts already emit these fields as JSON integers, so valid bundles require no migration. A published bundle containing a float, boolean, or numeric string in one of these identity fields is rejected fail-closed and should be regenerated rather than edited in place.

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
