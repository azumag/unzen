# Endpoint embedding source graph snapshot boundary

`tools/probe_llama_1b_endpoint_embedding_composition_ort_cpu.py` is a diagnostic-only CPU/ORT probe used while evaluating the Llama-3.2-1B endpoint layout path for #167.

The pinned source ONNX graph is read through one read-only, nonblocking regular-file descriptor. The probe records descriptor metadata before reading, rejects identity or metadata drift while opening or reading, and rechecks the requested/resolved pathname after the read. SHA-256 verification and ONNX parsing use exactly the bytes captured from that descriptor.

The same snapshot contract now also owns the optional pinned graph byte-length check. `_source_embedding_contract(..., expected_graph_bytes=...)` compares the requested byte-length against `len(graph_bytes)` from the already captured descriptor snapshot before ONNX parsing. Callers that do not request a byte-length pin retain the previous private helper call shape and behavior.

Both downstream embedding preparation paths use that snapshot-bound byte-length check:

- `tools/prepare_llama_1b_endpoint_embedding_tiled_ort_webgpu.py`
- `tools/prepare_llama_1b_endpoint_embedding_eight_physical_payloads.py`

They no longer perform a separate `source_model.stat().st_size` observation after or before the snapshot-based SHA-256/topology verification. As a result, the pinned graph length, digest, and ONNX topology are all evaluated from the same descriptor-captured bytes.

This prevents a pathname from being checked as one file and then reopened as a replacement file, FIFO, device, or directory for these source-graph checks. A malformed, raced, or byte-length-drifted source graph fails before endpoint payload execution.

The change does not select the 4-way/8-tile or 8-physical endpoint layout, change payload geometry, modify cache/runtime/dispatcher behavior, or constitute new physical WebGPU evidence. `decisionStatus=diagnostic-only` remains unchanged.

Regression coverage includes `tools/tests/test_probe_llama_1b_endpoint_embedding_composition_ort_cpu.py` and `tools/tests/test_endpoint_embedding_source_graph_size_snapshot.py`.
