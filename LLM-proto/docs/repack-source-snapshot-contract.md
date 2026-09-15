# Repack source descriptor snapshot contract

`tools/prepare_real_split.py::repack_segment_external_data()` copies only the external-data byte ranges referenced by a segment graph. Each source external-data pathname is resolved once, then opened and pinned before the repack destination is created or truncated.

The pinned source boundary requires:

- the resolved source path to identify a regular file before open;
- read-only open with nonblocking/no-follow flags where supported;
- the opened descriptor snapshot (device/inode, mode/link count, size, modification/change timestamps) to match the pre-open path snapshot; and
- the descriptor snapshot to remain unchanged after all requested ranges have been copied.

A FIFO/device/symlink substitution between path resolution and open therefore cannot turn into a blocking or special-file read, and in-place source mutation during the repack fails closed before the rewritten segment graph or manifest is published.

The source descriptor remains intentionally pinned after open. Retargeting the original source symlink later does not switch the bytes being copied; this preserves the existing source-pinning contract and its regression test.

Stable source files retain the existing per-segment artifact layout, byte-range deduplication, ONNX metadata, and manifest schema.

Regression coverage is in `tools/tests/test_prepare_real_split_source_pinning.py`.

## Evidence boundary

This is producer-side host filesystem integrity/reliability hardening under #167. It does not add real `Llama-3.2-1B-Instruct` q4 physical WebGPU, multi-browser Coordinator relay/latency, or worker-loss/resume evidence. The production/deploy/credential/billing HOLD scope in #158 is unchanged.
