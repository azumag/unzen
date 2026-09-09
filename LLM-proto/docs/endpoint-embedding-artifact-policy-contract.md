# Endpoint embedding artifact-policy contract verification

Issue #167 defines the browser cache artifact budget for the 1B q4 path: target about 200 MiB, preferred at or below 256 MiB, normal at or below 512 MiB, degraded exceptional at or below 1 GiB, and reject above 1 GiB. Issue #223's current diagnostic endpoint-embedding candidate represents the tied 1,050,673,152-byte embedding weight as four physical browser/cache artifacts and eight execution tiles.

`tools/verify_endpoint_embedding_artifact_policy_contract.mjs` turns the budget and byte geometry into an executable fail-close contract. This is intentionally separate from the manifest's exact-value validator. The exact validator detects drift from the currently pinned manifest; this policy verifier additionally prevents a future coordinated edit of both the expected contract and manifest from silently moving the diagnostic candidate outside #167's budget or introducing gaps/overlaps in the byte mapping.

Run it from `LLM-proto`:

```bash
node tools/verify_endpoint_embedding_artifact_policy_contract.mjs
```

The verifier checks all of the following:

- the tied embedding initializer byte length equals `rows * hiddenSize * 4` for the pinned FLOAT32 weight;
- `physicalArtifactCount` and `executionTileCount` match the actual arrays;
- physical artifact indexes are unique and remain in deterministic order;
- every physical artifact source span has the declared byte length;
- the physical artifact source ranges are gap-free and overlap-free across the complete embedding initializer;
- every pinned physical artifact remains within the preferred 256 MiB ceiling and, independently, the hard 1 GiB ceiling;
- the sum of physical artifact bytes exactly equals the embedding initializer bytes;
- execution tiles cover all vocabulary rows contiguously;
- each tile's byte length matches its row count and hidden width;
- each tile stays inside its owning physical artifact;
- each tile's `(physicalArtifact.sourceOffsetBytes + artifactByteOffset)` points to the exact source byte implied by its `startRow`;
- the tiles assigned to each physical artifact cover that artifact from byte 0 through its final byte with no gap or overlap;
- each tile's reported global token boundary agrees with its row boundary.

For the current pinned candidate the expected headline values are:

```text
embedding initializer              1,050,673,152 bytes
physical artifacts                 4
largest physical artifact            262,668,288 bytes
preferred 256 MiB headroom              5,767,168 bytes
hard 1 GiB headroom                  811,073,536 bytes
execution tiles                    8
largest execution tile               131,334,144 bytes
```

A pass only means that the currently pinned diagnostic candidate is internally byte-consistent and obeys the preferred browser artifact budget. It does **not** approve the four-artifact/eight-tile layout as production architecture, does not choose B1 over other endpoint strategies, does not relax #167's hard ceiling, and does not prove ONNX Runtime Web GPU allocation, peak-memory behavior, decoder/KV/checkpoint equivalence, cache semantics, or dispatcher design. Those remain separate evidence and maintainer decisions under #223/#167.
