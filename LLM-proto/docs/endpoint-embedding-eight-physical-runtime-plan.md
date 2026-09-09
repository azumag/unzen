# 8-physical endpoint embedding runtime plan

Tracking: #167, focused follow-up #322. Generated payload identities are produced by #320 / PR #321. Before browser execution, validate the actual files with `endpoint-embedding-eight-physical-bundle-preflight.md` (#324). The isolated browser diagnostic is tracked by #326.

## Purpose

This contract is the bridge between the diagnostic 8-physical payload generator and the isolated browser/ORT WebGPU capture. It validates the generated manifest and derives the exact runtime routing for all eight embedding tiles without selecting the 8-physical layout as the production architecture.

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

## Browser diagnostic harness

The browser experiment is gated by the actual-file preflight report from #324. Produce and preserve that report first:

```bash
cd LLM-proto
node tools/preflight_endpoint_embedding_eight_physical_bundle.mjs \
  /tmp/unzen-endpoint-embedding-eight-physical/manifest.json \
  /path/to/embedding-offset-0.onnx \
  /tmp/unzen-endpoint-embedding-eight-physical \
  > /tmp/unzen-endpoint-embedding-eight-physical-preflight.json
```

Then start only the isolated 8-physical harness:

```bash
DATA_DIR=/tmp/unzen-endpoint-embedding-eight-physical \
PREFLIGHT_REPORT=/tmp/unzen-endpoint-embedding-eight-physical-preflight.json \
GRAPH_PATH=/path/to/embedding-offset-0.onnx \
PORT=8797 \
node browser-harness/endpoint-embedding-eight-physical-webgpu/serve.mjs
```

The server validates that the supplied report is a `status=pass`, `decisionStatus=diagnostic-only`, actual-file integrity preflight before it listens. It also requires the pinned zero-offset graph as a separate non-symlink regular file. The browser then:

1. loads the validated preflight report and derives the eight-entry browser plan;
2. re-hashes the actual 260-byte graph served to the browser;
3. sequentially loads and re-hashes one 131,334,144-byte payload at a time;
4. creates a WebGPU-only ORT session with that verified payload supplied as external data for `payload-0000.bin`;
5. executes the first and last vocabulary row of the tile;
6. compares the ORT output byte-exactly with a JS reference read from the same verified payload bytes;
7. awaits `session.release()` and records create/run/release timings;
8. assembles all 16 sampled rows into a complete `[16, 2048]` result and compares it byte-exactly again.

The browser runtime report is exposed as `window.__unzenEndpointEmbeddingEightPhysicalWebGpuReport`. A passing report records the adapter identity/limits, ORT Web version, actual graph SHA-256, all eight actual payload SHA-256 values, per-tile timings/comparisons, complete comparison, and release completion.

No CI fixture is presented as real browser evidence. CI only syntax-checks the harness and regression-tests its input/routing contracts. A real Chrome/WebGPU capture still requires the real 1B payload bundle and a WebGPU-capable environment.

## Evidence boundary

This harness can establish the narrow ORT Web/WebGPU range-supply and embedding-equivalence evidence for the 8-physical endpoint candidate, but only when run against the real preflight-approved files in a real browser. Repository CI does **not** manufacture that evidence.

The generated manifest records payload hashes after the generator verifies the pinned full source external-data. The browser capture records the graph and payload hashes it actually loaded so the runtime evidence remains traceable to the preflight-approved bytes.

Even a green real-browser run does not select the 8-physical architecture. The remaining decision evidence includes host/GPU peak working set, cold/warm and first-useful-work timing, release/cancel reclamation, and decoder/KV/checkpoint full-model equivalence. Until those are captured, #167's permanent segment/cache/runtime policy remains unchanged.
