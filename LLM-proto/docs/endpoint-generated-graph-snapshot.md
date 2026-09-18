# Endpoint generated-graph snapshot boundary

`tools/prepare_llama_1b_endpoint_preferred_tile_ort_webgpu.py` emits small diagnostic ONNX graphs and records each graph's `bytes` and `sha256` in its generated manifest.

Those two fields now come from one read-only descriptor snapshot via `_measure_regular_file()`. The helper rejects symlinks and non-regular inputs, verifies the path identity against the opened descriptor, detects descriptor metadata drift while reading, and rechecks the pathname after the read. This prevents manifest size and digest from being assembled from different pathname targets.

`_sha256_file()` remains as a compatibility wrapper and returns the digest produced by the same descriptor-pinned primitive. Prefix hashing through `byte_limit` keeps its previous behavior, including unexpected-EOF failure when the requested prefix exceeds the file. The programmatic `byte_limit` contract is now explicit: callers may pass only `None` or an exact non-negative Python `int`; `bool`, negative integers, floats (including `NaN` and infinities), strings, and other non-integers are rejected before path expansion or filesystem I/O. Integer `0` continues to mean the empty prefix, positive integers hash exactly that prefix, and `None` hashes the full file.

This boundary is host-side integrity hardening only. `onnx.checker.check_model(str(path), ...)` still opens the pathname independently, so a fully transient swap that exists only during the checker call is outside this guarantee. Closing that stronger boundary would require changing how the checker consumes generated models and is not part of Issue #848.

This change also does not provide new physical WebGPU, browser working-set, multi-browser relay, or worker-loss/resume evidence for Issue #167, and it does not alter the HOLD scope of Issue #158.
