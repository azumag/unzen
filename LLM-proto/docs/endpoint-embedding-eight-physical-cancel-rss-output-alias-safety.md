# 8-physical cancellation RSS output/input alias safety

Both the direct cancellation RSS capture and the provenance-bound wrapper must not publish caller-visible outputs over a validated bundle input. The bound wrapper also requires its raw cancellation output and provenance sidecar to resolve to distinct filesystem destinations.

The direct `capture_endpoint_embedding_eight_physical_webgpu_cancel_rss.mjs` path loads and validates `PREFLIGHT_REPORT` before creating the output directory, allocating a temporary Chrome profile, probing ports, launching the harness server, or launching Chrome. It then applies the same shared alias policy used by `capture_endpoint_embedding_eight_physical_webgpu_cancel_rss_bound.mjs` to `OUTPUT_JSON`.

The bound wrapper applies that shared policy to both `CANCELLATION_OUTPUT_JSON` and `BOUND_OUTPUT_JSON` after the preflight report is loaded and validated, but before the bound sidecar is reserved or the browser child capture is launched. In addition to the existing lexical-distinct check, the shared guard rejects those two outputs when they are already the same file or when their existing parent directories canonicalize two otherwise different path strings onto the same destination. This includes two still-missing output files reached through real versus symlinked parent directories.

The guarded inputs are:

- the original `PREFLIGHT_REPORT`;
- `GRAPH_PATH`;
- every physical payload file declared by the validated preflight report and resolved below `DATA_DIR`.

The shared guard first rejects exact normalized aliases. It then performs bounded filesystem alias checks using the current namespace snapshot:

- an existing final output symlink is rejected rather than allowing pathname-based publication to follow it;
- existing paths with the same `dev` + `ino` identity are rejected, covering hard-link aliases;
- each existing output parent directory is canonicalized, so an output reached through a symlinked parent cannot silently resolve onto a validated input or the wrapper's other output destination.

This prevents either a direct raw capture or the bound wrapper's raw child capture from accidentally replacing a preflight report, executable graph, or prepared payload after that input has already been validated for the run. It also prevents the raw child from pathname-writing through an alternate parent onto the file descriptor that the wrapper has reserved for the bound sidecar. Keeping these checks in `tools/cancellation_rss_output_alias_guard.mjs` means the direct and bound paths do not maintain separate filesystem policies.

Ordinary output locations keep their existing behavior. Missing output files remain valid when they denote distinct destinations, and an unrelated existing regular raw cancellation output may still be replaced according to the existing raw-capture policy. This change does not alter evidence schemas, browser/runtime behavior, or the shared cleanup policy tracked in #1494.

The filesystem checks are preflight hardening, not a race-free namespace guarantee. Another same-user process can still rename or replace path components after the guard and before publication. The temporary preflight snapshot used by the bound wrapper and these alias checks therefore protect against deterministic configuration mistakes and pre-existing filesystem aliases; they do not claim adversarial filesystem isolation.

This is destructive-input/output separation for host-side diagnostic tooling only. It is not new physical WebGPU, real 1B q4, relay/latency, worker-loss/resume, or cache-residency evidence for #167.
