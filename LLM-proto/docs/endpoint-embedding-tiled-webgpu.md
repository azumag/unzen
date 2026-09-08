# Complete endpoint embedding ORT Web/WebGPU diagnostic

Status: **diagnostic-only / #223 S0 preparation**. This experiment does not select the 4-way physical / 8-way execution candidate and does not change production manifest, cache, loader, runtime, residency, dispatcher, or artifact-policy behavior.

## Purpose

The pinned CPU probe already established that a routed eight-tile embedding composition produces a byte-exact `[16, 2048]` result versus the full tied-weight `Gather` for both ends of every vocabulary tile. The remaining narrow browser-side question is whether the same complete routing works under ONNX Runtime Web `1.22.0` with the WebGPU execution provider while each 250.5 MiB physical payload is handled sequentially.

`tools/prepare_llama_1b_endpoint_embedding_tiled_ort_webgpu.py` prepares that experiment. It verifies the pinned Llama-3.2-1B q4 graph/external-data identity, materializes all four previously measured preferred physical payloads from their exact source ranges, and emits two deterministic `Gather` graphs: one for a zero external-data offset and one for the `131,334,144`-byte non-zero offset used by odd tiles. The graph digests are pinned to the already exercised single-payload WebGPU probe.

The preparation manifest fixes:

- source graph SHA-256 and 149,112-byte identity,
- source external-data SHA-256 and 1,692,672,000-byte identity,
- tied embedding geometry `[128256, 2048]` / 1,050,673,152 bytes,
- all four physical payload SHA-256 values and exact source ranges,
- all eight tile row/byte ranges and physical-artifact assignments,
- token IDs covering both ends of every tile,
- the two exact embedding graph digests,
- `decisionStatus=diagnostic-only`.

## Preparation

```bash
cd LLM-proto
python tools/prepare_llama_1b_endpoint_embedding_tiled_ort_webgpu.py \
  /absolute/path/to/model_q4.onnx \
  /absolute/path/to/model_q4.onnx_data \
  /tmp/unzen-endpoint-embedding-webgpu-data
```

The output directory must be empty and must not be a symlink. Preparation fail-closes on pinned source drift, payload digest drift, graph serialization drift, tile geometry drift, or token-routing drift.

## Browser run

```bash
DATA_DIR=/tmp/unzen-endpoint-embedding-webgpu-data PORT=8796 \
  node browser-harness/endpoint-embedding-tiled-webgpu/serve.mjs
```

Open `http://127.0.0.1:8796/` in a WebGPU-capable Chrome instance. The browser contract is validated before execution. Physical artifacts are loaded and SHA-256 verified in order `0 -> 1 -> 2 -> 3`; each payload backs exactly two tile sessions. The ONNX graph always names the external initializer path `payload-0000.bin`, while the harness supplies the currently verified physical payload bytes through ORT Web's `externalData` override. This deliberately reuses the two already pinned zero/non-zero-offset graph byte sequences rather than generating eight semantically duplicate graphs.

For each tile, the browser reconstructs the expected embedding rows directly from the verified payload bytes, executes `Gather` through the WebGPU provider, requires byte-exact equality, and awaits `InferenceSession.release()`. It then assembles all sixteen rows in original token order and requires the complete `[16, 2048]` result to remain byte-exact.

A successful self-reported runtime object is exposed as `window.__unzenEndpointEmbeddingWebGpuReport`.

## Captured runtime evidence

`tools/capture_endpoint_embedding_webgpu_runtime.mjs` turns the manual browser step into a repeatable diagnostic capture. It launches the existing harness server and an isolated temporary Chrome profile, connects through Chrome DevTools Protocol, waits for the runtime report, and validates the pinned source identity, ORT Web version, all four physical artifacts, all eight tile routes, byte-exact tile/complete comparisons, and release-API completion before writing evidence.

Before Chrome is launched, the helper requires distinct/free harness and DevTools ports and atomically reserves the output path with create-only permissions. This makes an existing evidence path fail immediately instead of wasting a complete browser run, and removes the reserved path if capture fails before a valid report is committed. The successful evidence write is flushed before the reserved descriptor is closed, so a concurrent writer cannot replace the target between validation and commit.

```bash
cd LLM-proto
node tools/capture_endpoint_embedding_webgpu_runtime.mjs \
  /tmp/unzen-endpoint-embedding-webgpu-data \
  /tmp/endpoint-embedding-webgpu-runtime.json
```

On macOS the default Chrome binary is `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`; elsewhere set `CHROME_BINARY` or pass the optional final CLI argument. The helper uses a tool-owned `mkdtemp` profile only and deletes that profile at exit. A passing captured report is promoted only from `self-reported-runtime` to `captured-browser-runtime`; its `decisionStatus` remains `diagnostic-only`. This capture records browser/environment identity but does not independently trace WebGPU provider assignment at each node or measure GPU allocation ownership.

## What this does not prove

This preparation and harness do not by themselves constitute real-browser evidence. A successful capture from the helper closes only the embedding-side browser/WebGPU S0 for the measured token set and captured browser/device. It does not prove decoder segmentation, KV-state continuity, Coordinator checkpoint relay, full-model staged equivalence, production cache semantics, peak host/GPU working set, or prompt/visitor UX. `InferenceSession.release()` completion is not evidence of immediate GPU-memory reclamation.
