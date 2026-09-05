# Multi-segment capture audit contract

Issue #167's one-shot host-side capture publishes the generated split artifacts,
`same-machine-evidence.json`, and `run-summary.json` as one immutable directory.
The capture is only same-machine correctness evidence; it does not replace the
required real multi-browser WebGPU / Coordinator relay evidence.

## Capture

```bash
python tools/capture_multi_segment_evidence_run.py \
  --full-model /absolute/path/to/Llama-3.2-1B-Instruct/onnx/model_q4.onnx \
  --output-dir /absolute/path/to/llama-1b-capture-001 \
  --input-ids '128000,2028,374,264,1296' \
  --kv-heads 8 \
  --head-size 64
```

The destination is no-clobber. Artifact generation, integrity preflight, and
full-vs-multi numerical verification complete in a staging directory before the
capture is published by a same-filesystem rename.

## Re-audit the published bundle

The bundle verifier does not load ONNX Runtime:

```bash
python tools/verify_multi_segment_capture_bundle.py \
  --capture-dir /absolute/path/to/llama-1b-capture-001
```

It re-hashes the published evidence and split artifacts, re-runs the stdlib-only
artifact integrity gate, and cross-binds the run summary, evidence envelope,
embedded verification report, and split manifest to one snapshot.

To also prove that the capture still points at the exact original full model and
external-data files, run:

```bash
python tools/verify_multi_segment_capture_source.py \
  --capture-dir /absolute/path/to/llama-1b-capture-001 \
  --full-model /absolute/path/to/Llama-3.2-1B-Instruct/onnx/model_q4.onnx
```

The source verifier re-hashes the full graph and every external-data file and
rejects source mutation while hashing.

## Exact JSON type contract

Published evidence is not permissive CLI input. Audit tools must reject values
that only become plausible after Python coercion.

- SHA-256 fields are JSON strings containing exactly 64 lowercase hexadecimal
  characters. A numeric JSON value containing 64 digits is invalid even though
  `str(value)` could look like a digest.
- Relative path and external-data `location` fields are non-empty JSON strings.
  Numbers and booleans are invalid even if stringifying them would name a file.
- Count and byte fields covered by the audit contract are exact JSON integers;
  booleans, floats, and numeric strings are rejected.
- Status fields are exact `"pass"` or `"fail"` strings.
- Absolute paths, parent traversal, and cross-platform traversal forms remain
  rejected before filesystem access.

These checks are intentionally fail-closed. A type-changing rewrite of a
published evidence document is treated as tampering rather than normalized into
the originally intended value.
