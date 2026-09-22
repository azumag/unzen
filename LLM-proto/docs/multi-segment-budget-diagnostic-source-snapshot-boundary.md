# Multi-segment budget diagnostic source-graph snapshot boundary

`tools/diagnose_multi_segment_budget.py` reports source-graph byte length and SHA-256 while parsing exactly the captured graph bytes. The filesystem snapshot that supplies those bytes is now owned by `tools/multi_segment_onnx.py::_read_source_graph_snapshot()` rather than duplicated in the diagnostic.

The diagnostic keeps `_read_source_graph_snapshot()` as its compatibility wrapper because tests and callers expect a three-value result: the requested absolute path, captured bytes, and digest. The wrapper delegates byte capture, size validation, regular-file checks, descriptor flags, path/descriptor identity checks, replacement-race detection, mutation detection, and SHA-256 calculation to the planner helper, then adds only the requested absolute path used in the report.

`DEFAULT_SOURCE_GRAPH_MAX_BYTES` is imported from `multi_segment_onnx.py` as the single default byte-ceiling policy. Future filesystem hardening must therefore change the planner helper once; the budget diagnostic automatically receives the same capture semantics instead of drifting behind a second implementation.

Existing diagnostic regressions continue to cover stable reads, the exact byte ceiling, invalid limits before filesystem access, binary-open flags, path replacement between check and open, in-place mutation, FIFO rejection, and the invariant that ONNX parsing consumes the same bytes whose digest is reported. A focused delegation regression additionally prevents the diagnostic from silently reintroducing an independent reader.

This is host-side reliability and maintainability hardening for #1444 / #167. It does not constitute new real 1B/q4 artifact-size, physical WebGPU, distinct-browser relay/latency, worker-loss/resume, or residency evidence, and it requires no production deployment, credentials, billing, model download, or external artifact access.
