# Endpoint post-stage RSS evidence output contract

Status: **diagnostic-only / host-side evidence reliability**. This contract does not promote endpoint readiness or count as new real-model, physical WebGPU, distinct-browser relay/latency, worker-loss/resume, or residency evidence.

`tools/capture_endpoint_poststage_webgpu_process_rss.mjs` and the endpoint embedding WebGPU capture share the neutral `tools/evidence_output_reservation.mjs` descriptor-bound reservation helper. The endpoint embedding capture re-exports the established helper names so existing imports remain compatible; this refactor does not change the filesystem contract.

Before creating the temporary Chrome profile or launching the harness/browser, the requested output path is reserved with exclusive creation (`wx`) and mode `0600`. A pre-existing destination is therefore rejected rather than overwritten.

The final JSON is written through the originally reserved descriptor, then `fsync`ed. Before the capture is considered committed, the pathname is checked again and must still identify the same regular-file device/inode as the open descriptor. Replacing, renaming, or retargeting the pathname during a long-running capture causes the capture to fail closed instead of committing evidence to a different path object.

Failure cleanup follows the shared generation-bound policy documented in [`evidence-output-reservation-cleanup-policy.md`](./evidence-output-reservation-cleanup-policy.md) (unzen#1494): an uncommitted reservation is removed only when the pathname still identifies the reserved device/inode generation, and only after the validated pathname has been renamed to a private, unpredictable sibling name whose generation is re-verified there, so a replacement landing between the identity check and the removal is restored rather than deleted. If another file has already replaced the pathname, cleanup neither renames nor deletes it. The helper reports cleanup success only after `unlink` succeeds and returns `false` otherwise — including when the runtime cannot provide the generation-bound sequence, in which case it mutates nothing and leaves the failed reservation artifact in place. The reserved descriptor is always closed after cleanup.

This changes only the host-side publication boundary for the diagnostic JSON. The evidence schema, RSS/footprint measurement semantics, browser flow, and `diagnostic-only` decision status are unchanged.
