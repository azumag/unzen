# Complete capture audit source postflight

`tools/audit_multi_segment_capture.py` performs a diagnostic-only post-publication audit of a persisted multi-segment capture and the original full-model source artifacts.

The complete audit now observes both sides of the provenance relationship more than once:

1. verify the persisted capture bundle;
2. verify the original source graph and external-data files, including the source verifier's own bundle snapshot;
3. verify the persisted capture bundle again;
4. verify the original source graph and external-data files again before emitting the final report.

The final source postflight is intentionally after the final bundle postflight. A successful report therefore requires the original source identity to remain unchanged across the complete audit's observed source snapshots, not merely to match once in the middle of the audit.

## Fail-closed bindings

The postflight source verification must retain the expected source-verifier `kind`, `schemaVersion`, and `status=pass`. It must also match the initially accepted observation for:

- `runSummarySha256`;
- `manifestSha256`;
- `evidenceSha256`;
- `verificationSha256`;
- capture status;
- source graph byte count and SHA-256;
- every source external-data `location`, byte count, and SHA-256;
- external-data entry count and aggregate byte count; and
- `sourcePathResolutionMode`.

The external-data list is revalidated before comparison: unsafe paths, duplicate locations, malformed byte counts, and non-canonical SHA-256 values fail closed. Aggregate count and byte totals must also agree with the entries.

When `--require-component-anchored-source` is used, the requirement is applied to both source observations. A postflight fallback to `final-component-only` therefore fails even if the earlier source observation used `component-anchored-dirfd`.

## Evidence boundary

This remains a discrete-snapshot audit. It materially narrows the window in which source artifacts can drift unnoticed, but it is not an fd-only transaction spanning ONNX execution or the full audit. A privileged mutation that occurs entirely between observations and is restored before the next source snapshot is outside this guarantee.

The audit also does not prove evidence-producer authenticity, WebGPU execution, GPU device-memory behavior, multi-browser checkpoint relay or worker-loss resume, or suitability of any physical artifact layout for production. Those remain separate evidence and architecture decisions under #167.
