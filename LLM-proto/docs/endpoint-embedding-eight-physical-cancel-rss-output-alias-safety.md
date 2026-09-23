# 8-physical cancellation RSS output/input alias safety

Both the direct cancellation RSS capture and the provenance-bound wrapper must not publish caller-visible outputs over a validated bundle input.

The direct `capture_endpoint_embedding_eight_physical_webgpu_cancel_rss.mjs` path now loads and validates `PREFLIGHT_REPORT` before creating the output directory, allocating a temporary Chrome profile, probing ports, launching the harness server, or launching Chrome. It then applies the same shared alias policy used by `capture_endpoint_embedding_eight_physical_webgpu_cancel_rss_bound.mjs` to `OUTPUT_JSON`.

The bound wrapper applies that shared policy to both `CANCELLATION_OUTPUT_JSON` and `BOUND_OUTPUT_JSON` after the preflight report is loaded and validated, but before the bound sidecar is reserved or the browser child capture is launched.

The guarded inputs are:

- the original `PREFLIGHT_REPORT`;
- `GRAPH_PATH`;
- every physical payload file declared by the validated preflight report and resolved below `DATA_DIR`.

The shared guard first rejects exact normalized path aliases. It then performs bounded filesystem alias checks when the relevant paths already exist:

- an existing final output symlink is rejected rather than allowing pathname-based publication to follow it;
- an existing output whose `dev` + `ino` identity matches a validated input is rejected, covering hard-link aliases;
- the output parent directory is canonicalized when it exists, so an output reached through a symlinked parent cannot silently resolve onto a validated input path.

This prevents either a direct raw capture or the bound wrapper's raw child capture from accidentally replacing a preflight report, executable graph, or prepared payload after that input has already been validated for the run. Keeping the filesystem policy in `tools/cancellation_rss_output_alias_guard.mjs` means the direct and bound paths do not maintain separate alias rules.

Ordinary output locations keep their existing behavior. Missing output files remain valid, and an unrelated existing regular raw cancellation output may still be replaced according to the existing raw-capture policy. This change does not alter evidence schemas, browser/runtime behavior, or the shared cleanup policy tracked in #1494.

The filesystem checks are a preflight hardening, not a race-free namespace guarantee. Another same-user process can still rename or replace path components after the guard and before publication. The temporary preflight snapshot used by the bound wrapper and these alias checks therefore protect against deterministic configuration mistakes and pre-existing filesystem aliases; they do not claim adversarial filesystem isolation.

This is destructive-input prevention for host-side diagnostic tooling only. It is not new physical WebGPU, real 1B q4, relay/latency, worker-loss/resume, or cache-residency evidence for #167.
