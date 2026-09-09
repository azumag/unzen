# 8-physical endpoint embedding runtime plan

Tracking: #167, focused follow-up #322. Generated payload identities are produced by #320 / PR #321.

## Purpose

This contract is the bridge between the diagnostic 8-physical payload generator and a future browser/ORT WebGPU capture. It validates the generated manifest and derives the exact runtime routing for all eight embedding tiles without selecting the 8-physical layout as the production architecture.

The existing 4-physical / 8-tile browser harness remains unchanged.

## Input

Generate the real payload set from the pinned Llama 1B graph and external-data file:

```bash
cd LLM-proto
python tools/prepare_llama_1b_endpoint_embedding_eight_physical_payloads.py \
  /path/to/model_q4.onnx \
  /path/to/model_q4.onnx_data \
  /tmp/unzen-endpoint-embedding-eight-physical
```

The generated `manifest.json` must remain:

- `status=pass`
- `decisionStatus=diagnostic-only`
- `selectedPhysicalArtifactCount=null`
- `candidatePhysicalArtifactCount=8`
- `executionTileCount=8`
- pinned source graph and full external-data identity
- eight contiguous 131,334,144-byte payloads named `payload-0000.bin` through `payload-0007.bin`
- eight 16,032-row tiles with same-index 1:1 physical routing and `artifactByteOffset=0`

`validateEndpointEmbeddingEightPhysicalManifest()` fails closed when these invariants drift.

## Runtime plan

`buildEndpointEmbeddingEightPhysicalRuntimePlan()` returns eight entries. Each entry pins:

- tile row range
- same-index physical payload file
- expected payload byte length and generated SHA-256
- source byte range
- graph file `embedding-offset-0.onnx`
- pinned graph identity: 260 bytes / SHA-256 `70a56611e458eb6af8333329424756275aa5ad6b08467fa51912532867b6ce50`
- graph external-data name `payload-0000.bin`
- `artifactByteOffset=0`

Because each 8-physical payload is exactly one execution tile, the already-generated zero-offset embedding graph can be reused for all eight tiles. No `embedding-offset-131334144.onnx` graph is needed for this diagnostic candidate.

A future browser harness should hash both the graph and each loaded payload before ORT session creation, compare them with the runtime-plan identities, and then supply the verified payload bytes via ORT Web `externalData` for the graph's `payload-0000.bin` initializer path.

## Evidence boundary

This change does **not** establish browser/WebGPU range-supply evidence by itself. It only makes the runtime routing deterministic and fail-closed before the real browser measurement.

The generated manifest records payload hashes after the generator verifies the pinned full source external-data. The browser capture must still record the graph and payload hashes it actually loaded; a CI fixture or structurally valid manifest is not a substitute for real 1B payload evidence.

The remaining decision evidence includes real ORT Web/WebGPU execution, host/GPU peak working set, cold/warm and first-useful-work timing, release/cancel lag, and numerical equivalence. Until those are captured, #167's permanent segment/cache/runtime policy remains unchanged.
