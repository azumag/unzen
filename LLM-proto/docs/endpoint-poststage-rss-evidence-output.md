# Endpoint post-stage RSS evidence output contract

Status: **diagnostic-only / host-side evidence reliability**. This contract does not promote endpoint readiness or count as new real-model, physical WebGPU, distinct-browser relay/latency, worker-loss/resume, or residency evidence.

`tools/capture_endpoint_poststage_webgpu_process_rss.mjs` and the endpoint embedding WebGPU capture share the neutral `tools/evidence_output_reservation.mjs` descriptor-bound reservation helper. The endpoint embedding capture re-exports the established helper names so existing imports remain compatible; this refactor does not change the filesystem contract.

Before creating the temporary Chrome profile or launching the harness/browser, the requested output path is reserved with exclusive creation (`wx`) and mode `0600`. A pre-existing destination is therefore rejected rather than overwritten.

The final JSON is written through the originally reserved descriptor, then `fsync`ed. Before the capture is considered committed, the pathname is checked again and must still identify the same regular-file device/inode as the open descriptor. Replacing, renaming, or retargeting the pathname during a long-running capture causes the capture to fail closed instead of committing evidence to a different path object.

Failure cleanup is identity-checked and best-effort: an uncommitted reservation is unlinked only when the pathname still identifies the originally reserved file. If another file has already replaced the pathname, cleanup leaves that replacement untouched. The helper reports cleanup success only after `unlink` succeeds; a contained unlink failure returns `false` so callers/tests are not told that a stale reservation was removed. The narrower identity-check-to-unlink namespace race is a separate portability/policy decision tracked by #1494 and is not changed here. The reserved descriptor is always closed after cleanup.

This changes only the host-side publication boundary for the diagnostic JSON. The evidence schema, RSS/footprint measurement semantics, browser flow, and `diagnostic-only` decision status are unchanged.
