# Complete multi-segment capture audit

For #167 host-side evidence, use the combined post-publication audit after a capture has been produced:

```bash
python tools/audit_multi_segment_capture.py \
  --capture-dir /path/to/capture \
  --full-model /path/to/model_q4.onnx
```

This command intentionally performs both layers of audit:

1. the published capture bundle is re-hashed and cross-bound with `run-summary.json`, `same-machine-evidence.json`, the split manifest, and the generated segment artifacts;
2. the resulting bundle is independently rebound to the original full ONNX graph and every source external-data file.

The source verifier performs its own bundle verification as well, so the combined command observes the capture twice. The final report is emitted only when the `run-summary.json`, split manifest, `same-machine-evidence.json`, embedded numerical verification digest, source graph digest, and capture status remain identical across those measurements. This binds the complete audit to one exact published control-file snapshot rather than only to a manifest-equivalent bundle.

The final report also preserves `sourcePathResolutionMode` from the source audit. It is one of:

- `component-anchored-dirfd`: intermediate source-path components were resolved relative to an anchored source-root directory descriptor and replacement-resistant checks were available;
- `final-component-only`: the portable fallback was used, so stable final-file identity is still checked but intermediate-directory replacement resistance is not claimed.

For high-assurance evidence collection where the stronger filesystem guarantee is mandatory, add:

```bash
python tools/audit_multi_segment_capture.py \
  --capture-dir /path/to/capture \
  --full-model /path/to/model_q4.onnx \
  --require-component-anchored-source
```

With this option the complete audit fails closed if the platform can provide only `final-component-only`. Without it, both known modes remain accepted for portability and the actual mode is still recorded in the report. Missing or unknown source path-resolution modes are never accepted as a passing complete audit.

A `status: pass` from this command means the stored evidence is internally consistent and still names the same source artifacts. It does **not** upgrade a numerical `captureStatus: fail` to success, and it does not constitute real multi-browser WebGPU evidence. The strict source-path option likewise changes only filesystem audit assurance; it does not authenticate the evidence producer, turn capture execution into a single fd-only transaction, or select a production artifact/runtime layout.

Use the lower-level verifier commands only when debugging a failed audit:

```bash
python tools/verify_multi_segment_capture_bundle.py --capture-dir /path/to/capture
python tools/verify_multi_segment_capture_source.py \
  --capture-dir /path/to/capture \
  --full-model /path/to/model_q4.onnx
```
