# Endpoint embedding composition source-graph budget

`tools/probe_llama_1b_endpoint_embedding_composition_ort_cpu.py` is a diagnostic-only host-side probe used while advancing Issue #167. Before ONNX parsing or pinned external-data work, it snapshots the source graph through the bounded reader owned by `tools/multi_segment_onnx.py`.

The probe uses `multi_segment_onnx.DEFAULT_SOURCE_GRAPH_MAX_BYTES` as the default graph ceiling so the endpoint composition path follows the same 64 MiB policy as the multi-segment generator and budget diagnostic. The shared reader validates the byte ceiling before filesystem work. A graph whose pre-open size exceeds the ceiling is rejected before opening; a graph that grows past the ceiling while being read is rejected after at most `max_bytes + 1` bytes have been observed.

The endpoint probe keeps a thin compatibility wrapper only because it also needs the resolved source path to locate ONNX external data. That wrapper binds the requested path before and after the shared capture, while the graph bytes themselves are read exactly once by `multi_segment_onnx._read_source_graph_snapshot()`. The regular-file check, safe open flags, path-to-open identity check, bounded descriptor read, read-time mutation check, and resolved-path recheck are not reimplemented in the endpoint probe.

The existing identity contract remains in force: stable symlinks are accepted, the resolved source must remain a regular file, replacement or mutation races fail closed, and stable input returns the resolved path plus the owned graph bytes used by the probe.

This boundary prevents an unexpectedly large or concurrently growing graph from causing an unbounded allocation and keeps future source-graph hardening single-sourced. It is reliability and memory-safety hardening only. Passing these checks is not real Llama-3.2-1B-Instruct q4 execution evidence, physical WebGPU evidence, distinct-browser relay/latency evidence, worker-loss/resume evidence, or cache-residency evidence, and it does not change the production HOLD in #158.
