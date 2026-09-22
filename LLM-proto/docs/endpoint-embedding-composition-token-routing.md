# Endpoint embedding composition token-routing invariant

`tools/probe_llama_1b_endpoint_embedding_composition_ort_cpu.py` compares a full tied-weight embedding `Gather` with the diagnostic 8-tile / 4-physical-payload composition used while advancing #167.

Before source external-data is opened or any ORT session is created, the probe snapshots each execution tile's `tileIndex`, `startRow`, `endRowExclusive`, and single `physicalArtifactIndex`, then preflights routing for the pinned `TOKEN_IDS` set. Every tile range must be a non-empty half-open range inside `[0, VOCAB_ROWS)`, every pinned probe token must belong to exactly one tile, and each tile must contain exactly one object-valued physical slice whose artifact index is a non-bool integer inside the already-pinned four-artifact set. Routing gaps, overlaps, malformed slices, and out-of-range physical indexes therefore fail as deterministic topology-contract errors before source external-data, payload, or ORT work begins.

The execution phase reuses the preflight snapshots rather than rereading the tile's physical-slice routing. This keeps malformed physical routing from surfacing later as a raw mapping lookup error after expensive reference/payload work has already occurred.

The preflight does not select or redesign the endpoint layout. The existing upstream 4-physical / 8-tile candidate, payload identities, ORT execution, exact-equality comparison, and report schema remain unchanged. It only turns malformed diagnostic routing into a deterministic fail-closed condition at the earliest local boundary.

This is host-side diagnostic reliability evidence only. It is not new real Llama-3.2-1B-Instruct q4 artifact evidence, physical WebGPU evidence, distinct-browser relay/latency evidence, worker-loss/resume evidence, or cache-residency evidence, and it does not change the production HOLD in #158.
