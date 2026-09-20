# Repacked external-data output snapshot contract

`tools/prepare_real_split.py::repack_segment_external_data()` produces one compact external-data file per segment. The manifest entry for that file contains both its byte size and SHA-256 digest, so those fields must describe the same artifact object that the repack operation wrote.

After the destination stream is flushed, the repack path records a content-relevant filesystem snapshot from the still-open descriptor: device/inode identity, file type and link count, byte size, and modification/change timestamps. After the segment graph is saved and runtime-checked, reporting reopens the external-data file read-only with nonblocking/no-follow flags where supported and requires:

- the pathname to still match the snapshot captured by this repack run;
- the opened descriptor to be a regular file with the same snapshot;
- file metadata relevant to content identity to remain stable while bytes are hashed; and
- the pathname snapshot after hashing to match the descriptor snapshot.

The reported `bytes` and `sha256` are then derived from that single descriptor observation. A pathname replacement, FIFO/device/symlink substitution, hard-link-count drift, or in-place content mutation fails closed instead of producing mixed metadata.

Destination-parent component anchoring is enabled only when the host exposes the callable filesystem primitives, `os.open(..., dir_fd=...)`, and integer open flags actually used by that path. Required flags must exist as integers; optional flags such as `O_CLOEXEC` and `O_NONBLOCK` may be absent, but a present malformed placeholder is treated as unsupported. The destination and measurement file-open helpers apply the same integer-flag validation before bitwise flag construction so reduced Python hosts fail with an intentional runtime error rather than leaking a raw `TypeError`. If component anchoring is unavailable, the existing pathname fallback policy is unchanged.

Stable files keep the existing per-segment external-data layout, ONNX metadata, and manifest schema. Segment graph hashing remains unchanged.

Regression coverage lives in `tools/tests/test_prepare_real_split_output_snapshot.py`, `tools/tests/test_prepare_real_split_destination_parent_anchor.py`, `tools/tests/test_prepare_real_split_destination_open_boundary.py`, and `tools/tests/test_prepare_real_split_capabilities.py`; the existing repack tests continue to exercise the normal producer flow.

## Evidence boundary

This is producer-side host filesystem integrity hardening under #167. It is not new real `Llama-3.2-1B-Instruct` q4 artifact-byte evidence, physical WebGPU evidence, multi-browser Coordinator relay/latency evidence, or worker-loss/resume evidence. The production/deploy/credential/billing HOLD scope in #158 is unchanged.
