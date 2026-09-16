# Capture source graph hash boundary

`tools/capture_multi_segment_evidence_run.py` binds the source ONNX graph before split generation and rechecks it before numerical verification. Those two digests are part of the host-side evidence contract for Issue #167.

The capture runner now reuses `multi_segment_onnx._read_source_graph_snapshot()` and the generator's existing `DEFAULT_SOURCE_GRAPH_MAX_BYTES = 64 MiB` policy for both source-graph digest passes. That helper opens one regular-file descriptor, reads at most the configured ceiling plus the single-byte overflow probe needed to reject growth, detects in-place mutation, and verifies that the requested pathname still resolves to the same source object before returning the ordinary SHA-256 digest.

This keeps source provenance aligned with the actual budgeted split runtime boundary. A malformed or unexpectedly huge `--full-model` graph can no longer force an unbounded full-file hash before the generator reaches its own graph-read ceiling. An oversized source graph fails before the capture staging directory is created and before shard generation begins. A graph exactly at the shared ceiling remains valid.

The pathname identity guarantees are preserved as well. If the source is replaced with another file, including a same-content replacement, while the bounded snapshot is being read, the helper detects the pathname/object drift and fails closed. The post-generation source provenance check calls the same bounded `sha256_file()` wrapper, so the initial and later source-graph digests cannot silently diverge in their size policy.

`sha256_file()` keeps its historical `chunk_size` argument for in-process compatibility, but the bounded generator snapshot owns the actual read chunking. `DEFAULT_SOURCE_GRAPH_MAX_BYTES` remains the single source-graph size policy for this capture path; the runner does not introduce a second capture-specific limit.

This boundary does not claim that all later ONNX Runtime access is descriptor-only. The runner still performs the existing post-generation digest comparison and artifact snapshot checks. The change only strengthens and bounds the source graph hash boundary without changing model splitting policy, browser artifact budgets, external-data hashing, or evidence semantics.
