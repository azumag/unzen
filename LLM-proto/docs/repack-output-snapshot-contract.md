# Repacked external-data output snapshot contract

`tools/prepare_real_split.py::repack_segment_external_data()` produces one compact external-data file per segment. The manifest entry for that file contains both its byte size and SHA-256 digest, so those fields must describe the same artifact object that the repack operation wrote.

After the destination stream is flushed, the repack path records the destination inode identity from the still-open descriptor. After the segment graph is saved and runtime-checked, reporting reopens the external-data file read-only with nonblocking/no-follow flags where supported and requires:

- the pathname to still identify the inode created/updated by this repack run;
- the opened descriptor to be a regular file with that identity;
- file metadata relevant to content identity to remain stable while bytes are hashed; and
- the pathname snapshot after hashing to match the descriptor snapshot.

The reported `bytes` and `sha256` are then derived from that single descriptor observation. A pathname replacement, FIFO/device/symlink substitution, hard-link-count drift, or in-place content mutation fails closed instead of producing mixed metadata.

Stable files keep the existing per-segment external-data layout, ONNX metadata, and manifest schema. Segment graph hashing remains unchanged.

Regression coverage lives in `tools/tests/test_prepare_real_split_output_snapshot.py`; the existing repack tests continue to exercise the normal producer flow.

## Evidence boundary

This is producer-side host filesystem integrity hardening under #167. It is not new real `Llama-3.2-1B-Instruct` q4 artifact-byte evidence, physical WebGPU evidence, multi-browser Coordinator relay/latency evidence, or worker-loss/resume evidence. The production/deploy/credential/billing HOLD scope in #158 is unchanged.
