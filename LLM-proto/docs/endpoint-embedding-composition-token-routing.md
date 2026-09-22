# Endpoint embedding composition token-routing invariant

`tools/probe_llama_1b_endpoint_embedding_composition_ort_cpu.py` compares a full tied-weight embedding `Gather` with the diagnostic 8-tile / 4-physical-payload composition used while advancing #167.

Before source external-data is opened or any ORT session is created, the probe now snapshots each execution tile's `tileIndex`, `startRow`, and `endRowExclusive` and preflights routing for the pinned `TOKEN_IDS` set. Every tile range must be a non-empty half-open range inside `[0, VOCAB_ROWS)`, and every pinned probe token must belong to exactly one tile. A routing gap or overlap therefore fails as a topology-contract error before `np.empty_like(reference)` can contain an unwritten row or a later tile can overwrite a position written by an earlier tile.

The preflight does not select or redesign the endpoint layout. The existing upstream 4-physical / 8-tile candidate, payload identities, ORT execution, exact-equality comparison, and report schema remain unchanged. It only turns malformed diagnostic routing into a deterministic fail-closed condition at the earliest local boundary.

This is host-side diagnostic reliability evidence only. It is not new real Llama-3.2-1B-Instruct q4 artifact evidence, physical WebGPU evidence, distinct-browser relay/latency evidence, worker-loss/resume evidence, or cache-residency evidence, and it does not change the production HOLD in #158.
