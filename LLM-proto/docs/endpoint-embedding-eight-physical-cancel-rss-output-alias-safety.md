# 8-physical cancellation RSS output/input alias safety

The provenance-bound cancellation RSS wrapper must not publish either of its caller-visible outputs over a validated bundle input.

After the preflight report is loaded and validated, but before the bound sidecar is reserved or the browser child capture is launched, `capture_endpoint_embedding_eight_physical_webgpu_cancel_rss_bound.mjs` rejects exact path aliases between either `CANCELLATION_OUTPUT_JSON` or `BOUND_OUTPUT_JSON` and:

- the original `PREFLIGHT_REPORT`;
- `GRAPH_PATH`;
- every physical payload file declared by the validated preflight report and resolved below `DATA_DIR`.

This guard prevents the raw child capture's pathname-based JSON publication from accidentally replacing a preflight report, executable graph, or prepared payload after that input has already been validated for the run. The bound sidecar receives the same explicit guard so both output arguments have one clear non-alias contract.

Ordinary output locations keep their existing behavior. In particular, this change does not alter the raw cancellation output's overwrite/no-overwrite policy for unrelated paths, and it does not change evidence schemas, browser/runtime behavior, or the shared cleanup policy tracked in #1494.

This is destructive-input prevention for host-side diagnostic tooling only. It is not new physical WebGPU, real 1B q4, relay/latency, worker-loss/resume, or cache-residency evidence for #167.
