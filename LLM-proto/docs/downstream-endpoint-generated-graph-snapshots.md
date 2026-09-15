# Downstream endpoint generated-graph metadata snapshots

Issue #850 extends the descriptor-snapshot boundary introduced by #848 / PR #849 to the downstream diagnostic endpoint preparers.

The five-way tile, complete post-stage, and tiled embedding preparers all generate small ONNX graph files and record both `bytes` and `sha256` in their diagnostic manifests. These two fields must describe the same observed file object. A pathname `stat()` followed by a separate digest open leaves a race in which the path can be replaced between observations, producing a size from one file and a digest from another.

All three downstream paths now obtain generated-graph `bytes` and `sha256` together through `prepare_llama_1b_endpoint_preferred_tile_ort_webgpu._measure_regular_file()`. That primitive opens one read-only, nonblocking, non-symlink regular-file descriptor, verifies identity before and after the read, rejects growth or mutation during hashing, and rechecks the pathname after the descriptor has been consumed. The manifest therefore receives size and SHA-256 from one descriptor-pinned snapshot.

This change intentionally preserves the existing manifest schemas, exact generated graph bytes/digests, ONNX validation, and `decisionStatus=diagnostic-only` semantics. It does not select an endpoint layout, alter cache/runtime/dispatcher contracts, or add evidence for physical WebGPU memory behavior, multi-browser relay/latency, or worker-loss/resume. Path-based work performed internally by `onnx.checker.check_model()` remains outside this metadata snapshot guarantee.
