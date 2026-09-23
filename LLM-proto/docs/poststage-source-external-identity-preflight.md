# Post-stage source external-data identity preflight

`tools/probe_llama_1b_endpoint_poststage_tiled_ort_cpu.py::build_report()` receives the source external-data identity from the in-process endpoint layout probe. After that upstream probe returns, the post-stage consumer validates the identity before it performs its own source-graph reload or opens the source external-data payload.

The byte count must be a positive non-boolean integer. The SHA-256 must be a string containing exactly 64 lowercase hexadecimal characters. A malformed returned identity fails with the existing deterministic `RuntimeError` before `_load_pinned_source_model()` or the shared pinned-payload opener can run.

This is deliberately a consumer-boundary invariant rather than a claim of zero source-graph I/O: the upstream layout probe necessarily inspects the source graph to construct the report in the first place. For valid identities, all existing source graph, source external-data, physical payload, ORT, and numerical checks remain unchanged.

This is host-side defensive hardening only and is not new real-model, browser/WebGPU, relay, residency, deployment, credential, billing, or model-acquisition evidence.
