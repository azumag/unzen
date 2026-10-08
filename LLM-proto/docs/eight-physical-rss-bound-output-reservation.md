# 8-physical RSS bound output reservation

The two provenance-bound 8-physical RSS wrappers use the shared `tools/evidence_output_reservation.mjs` contract for every output descriptor they own directly.

This applies to:

- `capture_endpoint_embedding_eight_physical_webgpu_process_rss_bound.mjs`, which owns both the copied normal-completion RSS JSON and the bound sidecar;
- `capture_endpoint_embedding_eight_physical_webgpu_cancel_rss_bound.mjs`, which owns the bound cancellation sidecar.

For those wrapper-owned outputs, publication now follows the same sequence as the other hardened evidence writers:

1. reserve the destination with exclusive create and mode `0600`;
2. keep the returned descriptor open while the capture runs;
3. write the completed JSON through that descriptor;
4. `fsync` the descriptor;
5. verify that the caller-visible pathname still resolves to the same regular-file identity as the reserved descriptor;
6. only then mark the output committed;
7. on failure, invoke the shared fail-closed cleanup policy before closing the descriptor.

A long-running capture therefore does not silently report success if the wrapper-owned output pathname was renamed or replaced before commit. The JSON schemas and diagnostic-only evidence semantics are unchanged.

The cancellation wrapper passes the raw output pathname to the direct child capture process; that child owns its own reservation and uses the same shared helper. The wrapper itself owns only the bound sidecar descriptor. The shared cleanup helper performs no filesystem operation and returns `false` on supported Node runtimes, as documented in [`evidence-output-reservation-cleanup-policy.md`](./evidence-output-reservation-cleanup-policy.md) (unzen#1494). Failed wrapper-owned reservations remain at their requested names, possibly empty or partially written; cleanup never deletes, renames, or overwrites unrelated files. Retry with different output names, or inspect and manually remove each failed artifact before reusing its name; occupied names fail exclusive reservation with `EEXIST`.

This is host-side evidence publication hardening only. It is not new real `Llama-3.2-1B-Instruct` q4 materialization evidence, physical WebGPU evidence, distinct-browser relay/latency evidence, worker-loss/resume evidence, or cache-residency evidence for #167.
