# Post-stage source graph digest preflight

`tools/probe_llama_1b_endpoint_poststage_tiled_ort_cpu.py::_load_pinned_source_model()` treats the upstream source-graph SHA-256 as control input. Before it reads filesystem metadata, the digest must be a string containing exactly 64 lowercase hexadecimal characters.

Malformed values, including non-strings, short or long strings, uppercase hexadecimal, and non-hexadecimal characters, fail with the diagnostic's `RuntimeError` taxonomy before `Path.lstat()` or the shared pinned-payload opener can run.

For valid digests, the existing trust boundary remains unchanged: the source graph is pinned through the shared regular-file/identity/hash checks, then read from the pinned descriptor and parsed only while that descriptor identity remains stable.

This is host-side fail-fast hardening only. It does not change pinned source identities, endpoint layout selection, ONNX Runtime numerical semantics, browser/WebGPU evidence, deployment, credentials, billing, or model acquisition.
