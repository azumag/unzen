# Direct 8-physical RSS output reservation

The directly executable 8-physical endpoint-embedding RSS capture tools publish diagnostic JSON through the shared evidence-output reservation boundary:

- `tools/capture_endpoint_embedding_eight_physical_webgpu_process_rss.mjs`
- `tools/capture_endpoint_embedding_eight_physical_webgpu_cancel_rss.mjs`

## Publication contract

Before browser/profile/server capture side effects, the tool reserves `OUTPUT_JSON` with `reserveEvidenceOutput()`. The shared helper creates the output exclusively with `wx` and mode `0600`, so an existing pathname is not overwritten.

Successful publication is descriptor-bound:

1. serialize the final diagnostic evidence to the already-open output descriptor;
2. `fsync` that descriptor;
3. verify that the output pathname still names the reserved descriptor identity;
4. mark the output committed.

If capture fails before commit, the shared `cleanupReservedEvidenceOutput()` policy returns `false` without any filesystem operation on the supported Node runtimes. The failed reservation remains at its requested pathname, possibly empty or partially written. The descriptor is closed on every path.

For cancellation capture, the validated bundle-input alias preflight remains earlier than output reservation. A malformed or aliased configuration therefore fails before creating the output reservation, while a valid configuration reserves its output before temporary-profile creation, port probing, harness-server launch, or Chrome launch.

## Compatibility and boundary

This intentionally changes direct raw capture from overwrite-at-end behavior to exclusive output creation. Retry after a failed capture, or preservation of an older evidence file, requires a new output pathname or operator inspection and manual removal of the existing artifact before capture. Reusing an occupied name fails with `EEXIST`.

Cleanup avoids the namespace race by making no filesystem changes under the shared fail-closed policy ([`evidence-output-reservation-cleanup-policy.md`](./evidence-output-reservation-cleanup-policy.md), unzen#1494): Node cannot guarantee generation-bound removal, so cleanup attempts no rename, quarantine, restore, or unlink and leaves replacements and unrelated files untouched.

This is host-side diagnostic evidence reliability hardening only. It does not add real `Llama-3.2-1B-Instruct` q4 execution evidence, physical WebGPU proof, distinct-browser relay/latency evidence, worker-loss/resume evidence, cache-residency evidence, production deployment, credentials, billing, or external model acquisition.

Related: #167, #1494, #1497, #1498, #1503, #1505, #1507.
