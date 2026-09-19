# Runtime checker graph snapshot contract

`tools/split_llama_1b_onnx.py::check_model_for_runtime()` validates generated split graphs before they are accepted for runtime use.

The graph pathname is untrusted across validation steps. A pathname-only `onnx.load_model(path)` followed by a later `onnx.checker.check_model(path)` can observe different filesystem objects, and a regular graph replaced with a FIFO or device can block before ONNX gets a chance to reject it.

The checker therefore acquires the serialized graph through the shared `open_regular_file_snapshot()` boundary first. That boundary pins one regular-file descriptor, opens with the platform-safe no-follow/nonblocking/raw-byte flags where available, rejects pre-open/post-open identity drift, rechecks the requested path, and rejects mutation before the snapshot is accepted. ONNX parses only the immutable bytes returned by that accepted snapshot with `load_external_data=False`.

For a normal graph, those exact serialized bytes are written through the exclusive `mkstemp()` descriptor to a temporary `.onnx` file beside the original graph. `onnx.checker` validates that temporary copy, so classification and checker validation are tied to the same serialized snapshot while relative external-data locations continue to resolve from the original graph directory.

For the narrowly allowlisted default-domain `SimplifiedLayerNormalization` runtime node, the same immutable snapshot is parsed first. The in-memory checker copy alone is remapped to `com.microsoft`, the custom-domain opset import is added when needed, and that derived graph is serialized to the same-directory temporary checker file. The published graph is never rewritten.

The temporary checker graph is removed on success or failure. Existing checker semantics remain unchanged: `full_check=False`, unknown/default-domain operators outside the allowlist still fail, and external-data files are not folded into the graph snapshot.

Focused regressions assert that normal graphs are checked from an exact same-directory byte copy, the allowlisted custom-op branch is derived from the accepted snapshot without mutating the source, and snapshot rejection happens before ONNX parsing or checker work. The shared snapshot boundary owns FIFO/special-file, same-content inode replacement, requested-path retarget, mutation, and Windows raw-byte behavior.

This is host-side validation hardening only. It does not change publication concurrency, legacy persisted deadline policy, browser artifact policy, production deployment, credentials, or billing.
