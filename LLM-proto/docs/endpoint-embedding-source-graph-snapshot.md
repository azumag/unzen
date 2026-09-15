# Endpoint embedding source graph snapshot boundary

`tools/probe_llama_1b_endpoint_embedding_composition_ort_cpu.py` is a diagnostic-only CPU/ORT probe used while evaluating the Llama-3.2-1B endpoint layout path for #167.

The pinned source ONNX graph is now read through one read-only, nonblocking regular-file descriptor. The probe records descriptor metadata before reading, rejects identity or metadata drift while opening or reading, and rechecks the requested/resolved pathname after the read. SHA-256 verification and ONNX parsing use exactly the bytes captured from that descriptor.

This prevents a pathname from being checked as one file and then reopened as a replacement file, FIFO, device, or directory. A malformed or raced source graph fails before endpoint payload execution.

The change does not select the 4-way/8-tile endpoint layout, change payload geometry, modify cache/runtime/dispatcher behavior, or constitute new physical WebGPU evidence. `decisionStatus=diagnostic-only` remains unchanged.

Regression coverage is in `tools/tests/test_probe_llama_1b_endpoint_embedding_composition_ort_cpu.py`.
