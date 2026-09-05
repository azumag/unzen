# Multi-segment evidence JSON type contract

The #167 host-side capture and post-publication verifiers treat byte-count fields as immutable evidence, not as user-friendly CLI input.

For source-artifact verification, the following fields must therefore be JSON integers (`0`, `123`, ...), never floating-point values, booleans, or numeric strings:

- `split-manifest.sourceModel.externalData[].bytes`
- `same-machine-evidence.verification.sourceModel.graphBytes` when present
- `same-machine-evidence.verification.sourceModel.externalData[].bytes`

The source verifier intentionally does not coerce values with `int(...)`. Coercion can silently normalize malformed evidence; for example, JSON `12.9` becomes Python integer `12`, which could then compare equal to a measured 12-byte file and incorrectly pass an integrity audit.

Generated capture artifacts already emit these fields as JSON integers, so valid bundles require no migration. A published bundle containing a float or numeric string in one of these identity fields is rejected fail-closed and should be regenerated rather than edited in place.

Run the source audit with:

```bash
python tools/verify_multi_segment_capture_source.py \
  --capture-dir /absolute/path/to/capture \
  --full-model /absolute/path/to/model_q4.onnx
```

A successful audit still means only that the published capture and the supplied source files are cryptographically and structurally consistent. It does not upgrade a failed numerical comparison to a passing one and does not replace the real multi-browser WebGPU evidence required by #167.
