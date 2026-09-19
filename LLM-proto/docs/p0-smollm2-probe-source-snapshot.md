# SmolLM2 P0 graph probe source snapshot

`tools/probe_p0_smollm2_graph.py` validates the pinned SmolLM2-135M q4 graph used by the browser P0 CI path. The probe now parses the graph from the shared bounded `source_file_snapshot` reader instead of asking ONNX to reopen the pathname directly.

The source graph is therefore captured from one regular-file descriptor identity before ONNX parsing. The shared snapshot boundary rejects non-regular or replaced inputs, uses fail-fast descriptor flags where the host provides them, reads raw bytes on platforms with `O_BINARY`, detects descriptor mutation while reading, and rechecks both the resolved target and the originally requested path before the captured bytes are accepted.

ONNX still receives `load_external_data=False`, the existing layer-15 boundary discovery is unchanged, and the JSON output schema is unchanged. The only behavioral change is that an unstable or unsafe source pathname fails before `onnx.load_model` runs.

The probe uses the same `DEFAULT_SOURCE_GRAPH_MAX_BYTES` bound as the legacy split source graph snapshot. This prevents an unexpectedly large graph file from turning the CI structural probe into an unbounded host-memory read while preserving the pinned model used by the current workflow.

This is host-side probe reliability hardening only. It does not add physical WebGPU execution, browser working-set evidence, multi-browser relay/latency evidence, worker-loss/resume evidence, production deployment, credentials, or billing activity.

Related: #167, #1157.
