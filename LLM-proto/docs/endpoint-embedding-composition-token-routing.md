# Endpoint embedding composition token-routing invariant

`tools/probe_llama_1b_endpoint_embedding_composition_ort_cpu.py` compares a full tied-weight embedding `Gather` with the diagnostic 8-tile / 4-physical-payload composition used while advancing #167.

Before source external-data is opened or any ORT session is created, the probe first snapshots the candidate's four `physicalArtifacts` entries into a strict index-to-byte-length table. Every descriptor must be an object, `index` must be a unique non-bool integer in `0..3` with the complete set present, and `byteLength` must be a positive non-bool integer. Malformed, coercible, duplicate, or incomplete descriptors therefore fail before source hashing, reference ORT execution, or payload opening.

The probe then snapshots each execution tile's `tileIndex`, `startRow`, `endRowExclusive`, and single physical slice, and preflights routing for the pinned `TOKEN_IDS` set. Every tile range must be a non-empty half-open range inside `[0, VOCAB_ROWS)`, every pinned probe token must belong to exactly one tile, and each tile must contain exactly one object-valued physical slice whose artifact index is inside the already-pinned four-artifact set. Routing gaps, overlaps, malformed slices, and out-of-range physical indexes therefore fail as deterministic topology-contract errors at the same early boundary.

For the executable composition path, the slice snapshot also validates `rowCount`, `artifactByteOffset`, and `byteLength` before any source/reference/payload work. These values must be non-coercible integer geometry, `rowCount` must equal `endRowExclusive - startRow`, `byteLength` must equal `rowCount * HIDDEN_SIZE * FLOAT32_BYTES`, and `artifactByteOffset + byteLength` must fit inside the preflighted byte length of the selected physical artifact. This pins the exact float32 tensor range that will later be exposed through `/dev/fd/<payload>`.

The execution phase consumes an owned tile/slice snapshot produced by that preflight. It does not reread the original caller-owned `physicalSlices` container when creating the temporary ORT tile model. This prevents upstream mutation or malformed late geometry from changing the external tensor after the expensive full-weight reference execution has already started.

The preflight does not select or redesign the endpoint layout. The existing upstream 4-physical / 8-tile candidate, payload identities, ORT execution, exact-equality comparison, and report schema remain unchanged. It only turns malformed diagnostic routing and slice geometry into a deterministic fail-closed condition at the earliest local boundary.

This is host-side diagnostic reliability evidence only. It is not new real Llama-3.2-1B-Instruct q4 artifact evidence, physical WebGPU evidence, distinct-browser relay/latency evidence, worker-loss/resume evidence, or cache-residency evidence, and it does not change the production HOLD in #158.
