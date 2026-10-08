# Endpoint post-stage RSS evidence output contract

Status: **diagnostic-only / host-side evidence reliability**. This contract does not promote endpoint readiness or count as new real-model, physical WebGPU, distinct-browser relay/latency, worker-loss/resume, or residency evidence.

`tools/capture_endpoint_poststage_webgpu_process_rss.mjs` and the endpoint embedding WebGPU capture share the neutral `tools/evidence_output_reservation.mjs` descriptor-bound reservation helper. The endpoint embedding capture re-exports the established helper names so existing imports remain compatible; this refactor does not change the filesystem contract.

Before creating the temporary Chrome profile or launching the harness/browser, the requested output path is reserved with exclusive creation (`wx`) and mode `0600`. A pre-existing destination is therefore rejected rather than overwritten.

The final JSON is written through the originally reserved descriptor, then `fsync`ed. Before the capture is considered committed, the pathname is checked again and must still identify the same regular-file device/inode as the open descriptor. Replacing, renaming, or retargeting the pathname during a long-running capture causes the capture to fail closed instead of committing evidence to a different path object.

Failure cleanup follows the shared fail-closed policy documented in [`evidence-output-reservation-cleanup-policy.md`](./evidence-output-reservation-cleanup-policy.md) (unzen#1494): on the supported Node runtimes it performs no filesystem operation and returns `false`. An unchanged failed reservation remains at the requested pathname, possibly empty or partially written; committed evidence, replacements, and unrelated files are never deleted, renamed, or overwritten by cleanup. The reserved descriptor is always closed afterward. Retry with a different output name, or inspect and manually remove the failed artifact before reusing the same name; otherwise exclusive reservation fails with `EEXIST`.

This changes only the host-side publication boundary for the diagnostic JSON. The evidence schema, RSS/footprint measurement semantics, browser flow, and `diagnostic-only` decision status are unchanged.
