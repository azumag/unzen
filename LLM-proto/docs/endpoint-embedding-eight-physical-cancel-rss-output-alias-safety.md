# 8-physical cancellation RSS output/input alias safety

The provenance-bound cancellation RSS wrapper must not publish either of its caller-visible outputs over a validated bundle input.

After the preflight report is loaded and validated, but before the bound sidecar is reserved or the browser child capture is launched, `capture_endpoint_embedding_eight_physical_webgpu_cancel_rss_bound.mjs` rejects aliases between either `CANCELLATION_OUTPUT_JSON` or `BOUND_OUTPUT_JSON` and:

- the original `PREFLIGHT_REPORT`;
- `GRAPH_PATH`;
- every physical payload file declared by the validated preflight report and resolved below `DATA_DIR`.

The guard first rejects exact normalized path aliases. It then performs bounded filesystem alias checks when the relevant paths already exist:

- an existing final output symlink is rejected rather than allowing pathname-based publication to follow it;
- an existing output whose `dev` + `ino` identity matches a validated input is rejected, covering hard-link aliases;
- the output parent directory is canonicalized when it exists, so an output reached through a symlinked parent cannot silently resolve onto a validated input path.

This prevents the raw child capture's pathname-based `writeFileSync(...)` publication from accidentally replacing a preflight report, executable graph, or prepared payload after that input has already been validated for the run. The bound sidecar receives the same explicit guard so both output arguments have one clear non-alias contract.

Ordinary output locations keep their existing behavior. Missing output files remain valid, and an unrelated existing regular raw cancellation output may still be replaced according to the existing raw-capture policy. This change does not alter evidence schemas, browser/runtime behavior, or the shared cleanup policy tracked in #1494.

The filesystem checks are a preflight hardening, not a race-free namespace guarantee. Another same-user process can still rename or replace path components after the guard and before the child publication. The temporary preflight snapshot and these alias checks therefore protect against deterministic configuration mistakes and pre-existing filesystem aliases; they do not claim adversarial filesystem isolation.

This is destructive-input prevention for host-side diagnostic tooling only. It is not new physical WebGPU, real 1B q4, relay/latency, worker-loss/resume, or cache-residency evidence for #167.
