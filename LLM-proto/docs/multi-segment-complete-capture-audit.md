# Complete multi-segment capture audit

For #167 host-side evidence, use the combined post-publication audit after a capture has been produced:

```bash
python tools/audit_multi_segment_capture.py \
  --capture-dir /path/to/capture \
  --full-model /path/to/model_q4.onnx
```

This command intentionally performs both layers of audit:

1. the published capture bundle is re-hashed and cross-bound with `run-summary.json`, `same-machine-evidence.json`, the split manifest, and the generated segment artifacts;
2. the resulting bundle is independently rebound to the original full ONNX graph and every source external-data file;
3. after source verification completes, the published capture bundle is re-hashed once more before the complete report is emitted.

The source verifier performs its own bundle verification as well, so the combined command observes the capture before, during, and after source verification. The final report is emitted only when the `run-summary.json`, split manifest, `same-machine-evidence.json`, embedded numerical verification digest, source graph digest, capture status, segment/budget metadata, and path-resolution assurance remain identical across the observed bundle snapshots. This closes the ordinary post-source audit window where a capture could otherwise change after source verification had already returned but before the combined report was published.

The final post-source bundle pass is a full subordinate verification, not a digest-only spot check. Its `kind`, `schemaVersion`, and `status` are validated again; the control-file digests, source graph digest, `segmentCount`, `maximumSegmentArtifactBytes`, `effectiveRequiredMaxBytes`, `captureSnapshotPathResolutionMode`, and `auditSnapshotPathResolutionMode` must all still match the initial bundle measurement. When `--require-component-anchored-artifacts` is enabled, the post-source bundle verification must also use `component-anchored-dirfd`.

This is still a discrete-snapshot guarantee rather than a single transaction: a privileged mutation that occurs entirely between observations and is perfectly restored before the next snapshot is outside this tool's claim. The stronger fd-only execution boundary remains separate work.

The complete audit also pins the contracts of both subordinate verifiers before trusting `status` or any digest field. The currently accepted reports are:

- bundle verification: schema `1.1.0`, kind `unzen-budgeted-multi-segment-capture-bundle-verification`;
- source verification: schema `1.0.0`, kind `unzen-budgeted-multi-segment-capture-source-verification`.

Missing or different `schemaVersion` / `kind` values fail closed. This is intentional: a future subordinate-verifier schema change must be reviewed and the complete audit updated explicitly rather than being accepted only because similarly named fields still exist. The final report records the accepted contracts in `bundleVerificationKind`, `bundleVerificationSchemaVersion`, `sourceVerificationKind`, and `sourceVerificationSchemaVersion`.

The combined boundary also revalidates machine-consumed metadata before copying it into the final report. `segmentCount`, `maximumSegmentArtifactBytes`, and `effectiveRequiredMaxBytes` must remain positive JSON integers; booleans and numerically equivalent floats are rejected. `sourceGraphBytes`, `sourceExternalDataCount`, and `sourceExternalDataBytes` must be non-negative JSON integers. Every `sourceExternalData` entry must remain an object with a safe relative `location`, non-negative integer `bytes`, and canonical lowercase SHA-256 digest; duplicate locations are rejected. The declared external-data count must equal the number of entries and the declared byte total must equal the sum of entry bytes. `captureStatus` is restricted to the known numerical outcomes `pass` or `fail` and must agree between the subordinate measurements and the final bundle postflight. A valid `captureStatus: fail` remains auditable: the complete audit can pass while proving that the stored numerical run itself failed.

The final report preserves three path-resolution assurance fields:

- `captureSnapshotPathResolutionMode`: the generated artifact snapshot mode recorded by the original capture preflight. Older schema-1.0 bundles may legitimately report `null` because this metadata was not recorded at capture time; the audit never invents a historical mode.
- `auditSnapshotPathResolutionMode`: the mode actually used by the current post-publication generated-artifact snapshot audit. A passing complete audit always requires one of the known modes, and the initial and final bundle measurements must agree.
- `sourcePathResolutionMode`: the mode used while rebinding the capture to the original source graph and source external-data files.

Known non-null modes are:

- `component-anchored-dirfd`: intermediate path components were resolved relative to an anchored directory descriptor and replacement-resistant checks were available;
- `final-component-only`: the portable fallback was used, so stable final-file identity is still checked but intermediate-directory replacement resistance is not claimed.

By default both known modes remain accepted for portability. Missing or unknown current audit modes are never accepted. An unknown historical `captureSnapshotPathResolutionMode` is represented only as `null` for legacy bundles.

For high-assurance evidence collection where stronger filesystem guarantees are mandatory, the generated-artifact audit and source audit can be required independently:

```bash
python tools/audit_multi_segment_capture.py \
  --capture-dir /path/to/capture \
  --full-model /path/to/model_q4.onnx \
  --require-component-anchored-artifacts \
  --require-component-anchored-source
```

`--require-component-anchored-artifacts` fails closed unless both the initial and final **current post-publication artifact snapshot audits** used `component-anchored-dirfd`. It intentionally does not require the historical capture-time mode to be known, so legacy bundles can still be re-audited strongly on a capable host. `--require-component-anchored-source` independently requires the original source-model audit to use the stronger mode. Either option may be used on its own.

A `status: pass` from this command means the stored evidence is internally consistent, remained stable across the observed complete-audit snapshots, and still names the same source artifacts under the explicitly pinned verifier contracts. It does **not** upgrade a numerical `captureStatus: fail` to success, and it does not constitute real multi-browser WebGPU evidence. The strict path options likewise change only filesystem audit assurance; they do not authenticate the evidence producer, turn capture execution into a single fd-only transaction, prove GPU device-memory behavior, or select a production artifact/runtime layout.

Use the lower-level verifier commands only when debugging a failed audit:

```bash
python tools/verify_multi_segment_capture_bundle.py --capture-dir /path/to/capture
python tools/verify_multi_segment_capture_source.py \
  --capture-dir /path/to/capture \
  --full-model /path/to/model_q4.onnx
```
