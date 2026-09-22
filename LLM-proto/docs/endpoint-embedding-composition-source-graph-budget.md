# Endpoint embedding composition source-graph budget

`tools/probe_llama_1b_endpoint_embedding_composition_ort_cpu.py` is a diagnostic-only host-side probe used while advancing Issue #167. Before ONNX parsing or pinned external-data work, it snapshots the source graph through a bounded regular-file read.

The probe uses `multi_segment_onnx.DEFAULT_SOURCE_GRAPH_MAX_BYTES` as the default graph ceiling so the endpoint composition path follows the same 64 MiB policy as the multi-segment generator and budget diagnostic. The byte ceiling is validated before filesystem work. A graph whose pre-open size exceeds the ceiling is rejected before opening; a graph that grows past the ceiling while being read is rejected after at most `max_bytes + 1` bytes have been observed.

The existing identity contract remains in force: the resolved source must be a regular file, path-to-open and read-time identity changes fail closed, and the requested path must still resolve to the same file after capture. Stable input returns the resolved path plus the owned graph bytes used by the probe.

This boundary prevents an unexpectedly large or concurrently growing graph from causing an unbounded `read()` allocation. It is reliability and memory-safety hardening only. Passing these checks is not real Llama-3.2-1B-Instruct q4 execution evidence, physical WebGPU evidence, distinct-browser relay/latency evidence, worker-loss/resume evidence, or cache-residency evidence, and it does not change the production HOLD in #158.
