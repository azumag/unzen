# Endpoint layout candidate probe

Status: **diagnostic-only / #223 feasibility support**. This document and its probes do not choose the endpoint runtime/cache architecture, change the artifact policy, or approve a browser execution profile.

## Purpose

`tools/probe_llama_1b_endpoint_layout_candidates.py` turns the pinned endpoint row geometry already verified by `probe_llama_1b_endpoint_chunk_envelope.py` into an explicit comparison between **physical cache-artifact geometry** and **execution-tile geometry**.

The comparison exists to support the pre-decision S0 feasibility work discussed in #223. It keeps four concepts separate:

- source weight rows/bytes,
- balanced physical payload candidates,
- balanced execution row views,
- the exact mapping from each execution view to physical-payload byte offsets and pinned source-byte offsets.

It intentionally does not define a manifest, Cache API layout, ORT external-data binding, worker assignment, GPU buffer, or runtime stage.

## Pinned geometry

The upstream pinned probe must pass first and remain `decisionStatus=diagnostic-only`. The candidate report carries the upstream probe kind/schema, pinned source graph SHA-256, and pinned external-data location/size/SHA-256 so the comparison cannot be detached from the source identity that established the row geometry.

- tied weight rows: `128256`
- row bytes: `8192`
- total tied-weight bytes: `1,050,673,152`
- source location: `model_q4.onnx_data`
- source offset: `0`
- preferred physical payload ceiling used for this diagnostic comparison: `256 MiB`
- target used only as a distance reference: `200 MiB`

The candidate probe compares balanced `4`, `5`, and `8` physical payloads while holding the diagnostic execution view at `8` balanced vocabulary-row tiles.

## Expected candidate geometry

| physical payloads | max physical bytes | max physical MiB | relation to 200 MiB target | 8 execution tiles | max physical payloads touched by one tile | total physical slices across 8 tiles |
|---:|---:|---:|---:|---|---:|---:|
| 4 | 262,668,288 | 250.5 | +52,953,088 bytes | every tile stays within one physical payload, but half-payload tile boundaries exist | 1 | 8 |
| 5 | 210,141,184 | 200.40625 | +425,984 bytes | some tiles cross a physical-payload boundary | 2 | 12 |
| 8 | 131,334,144 | 125.25 | -78,381,056 bytes | physical and execution boundaries align 1:1 | 1 | 8 |

All three raw physical layouts are below the current preferred `256 MiB` payload ceiling. This is **byte geometry only**. It does not imply that any candidate meets host-memory, GPU-memory, ORT session, cache-quota, latency, cancellation, or numerical-equivalence requirements.

The 5-way candidate is useful because it is closest to the existing ~200 MiB target, but its 8-way execution views are not naturally aligned: tile-to-artifact binding must sometimes combine two physical slices. The 4-way candidate preserves the already materialized preferred evidence and lets each 8-way tile remain inside one physical payload, while execution boundaries can occur inside a payload. The 8-way candidate makes physical and execution boundaries identical but doubles the physical object count relative to the existing 4-way materialization evidence.

These observations are inputs to a later design decision, not a ranking.

## Exact range bindings

Report schema `1.1.0` adds enough arithmetic coordinates to hand one tile to the next S0 range-supply spike without guessing how a row interval maps back to bytes.

Each execution tile records:

- `sourceOffsetBytes` / `sourceEndOffsetBytesExclusive`,
- its full `byteLength`,
- one or more `physicalSlices`.

Each physical slice records:

- `physicalArtifactIndex`,
- row coverage,
- `artifactByteOffset` / `artifactByteEndOffsetExclusive` relative to that physical payload,
- the corresponding pinned `sourceOffsetBytes` / `sourceEndOffsetBytesExclusive`,
- exact `byteLength`.

The probe fail-closes if physical slices are not contiguous in rows and source bytes, exceed their physical-artifact byte range, do not sum to the tile byte length, or do not cover the tile source range exactly. Candidate summaries also report `totalPhysicalSlicesAcrossExecutionTiles` and `executionTileSourceRangesCoverWeightExactly`.

For example, the second 8-way tile (`rows [16032,32064)`) in the 5-physical candidate is exactly two reads:

- physical 0: artifact bytes `[131,334,144,210,141,184)`, source bytes `[131,334,144,210,141,184)`, `78,807,040` bytes,
- physical 1: artifact bytes `[0,52,527,104)`, source bytes `[210,141,184,262,668,288)`, `52,527,104` bytes.

Together they cover the tile's source range `[131,334,144,262,668,288)` with no gap or overlap. This is still a coordinate proof only; it does not prove that ORT Web accepts this supply pattern or that the bytes can be staged within the desired memory budget.

## Whole-artifact dependency closure

`tools/probe_llama_1b_endpoint_dependency_closure.py` consumes the layout report and adds one deliberately conservative accounting view: **if cache/residency identity is the whole physical artifact, how many full physical-artifact bytes are in the dependency closure of each execution tile?**

This is not a host-memory or GPU-memory measurement. A runtime might stream a slice, reuse an already cached object, or avoid copying all bytes into one buffer. The closure instead records the amount of independently identified physical artifact data that must be available/verified before the tile can be satisfied under a whole-artifact cache/residency contract.

The current `256 MiB` preferred limit is carried into this report **only as a numeric reference taken from the physical-artifact policy**. #223 does not currently define a 256 MiB execution-dependency-closure policy, so the companion probe does not convert this comparison into a pass/fail gate.

For the pinned geometry:

| physical payloads | max full-artifact dependency closure per 8-way tile | max bytes in required artifacts not used by that tile | distance from 256 MiB physical-artifact reference |
|---:|---:|---:|---:|
| 4 | 262,668,288 bytes (250.5 MiB) | 131,334,144 | -5,767,168 bytes |
| 5 | 420,274,176 bytes (400.8046875 MiB) | 288,940,032 | +151,838,720 bytes |
| 8 | 131,334,144 bytes (125.25 MiB) | 0 | -137,101,312 bytes |

The 5-way result is the important new comparison. Although every individual 5-way physical payload is close to the 200 MiB target and below 256 MiB, a boundary-crossing execution tile references two whole physical artifacts. Counting those cache/residency dependencies in full produces a maximum closure of `420,274,176` bytes. Therefore "every physical artifact is preferred-sized" does not imply that the execution dependency closure has the same byte scale.

The 4-way and 8-way arithmetic mappings fall below the same 256 MiB numeric reference, while the 5-way maximum is above it. The 4-way mapping still has `131,334,144` bytes in the required artifact that the tile itself does not consume, while the 8-way 1:1 alignment has zero such unused bytes. These numbers are comparison inputs only; they do not select 4 or 8 and they do not create a new policy gate, because request count, session count, cache reuse, transfer behavior, working set, and ORT/WebGPU feasibility remain unmeasured.

The dependency-closure probe fail-closes on unknown/duplicate physical-artifact references, mismatched slice byte totals, malformed artifact sizes/counts, or any upstream promotion away from `decisionStatus=diagnostic-only`.

## Pinned CPU ORT tile execution spike

`tools/probe_llama_1b_endpoint_preferred_tile_ort_cpu.py` takes the already materialized and hash-pinned **4-way preferred physical payloads** and executes the two primitive operations that directly consume the tied endpoint weight for each of the eight diagnostic execution tiles:

- embedding-side `Gather`, using tile-local token IDs,
- logits-side `Transpose + MatMul`, using a deterministic sparse hidden vector.

The generated ONNX models keep the weight external. Each tile initializer points directly at the tile byte range inside `payload-0000.bin` through `payload-0003.bin`; odd-numbered tiles therefore exercise a non-zero external-data offset inside a physical payload. The helper refuses payload symlinks, verifies exact physical payload sizes, and fail-closes unless each full physical payload SHA-256 matches the previously materialized preferred-tier evidence recorded for #223. It pins every verified payload by open file descriptor, points ORT at `/dev/fd/<fd>`, and rechecks the requested payload path identity after execution so pathname replacement cannot silently redirect the run. It also requires `onnxruntime==1.22.0` and `CPUExecutionProvider`.

This is still **diagnostic-only**. It deliberately uses CPU ORT rather than ORT Web/WebGPU, does not include final norm, does not execute decoder layers, and does not choose the 4-way layout. Its purpose is narrower: prove that the exact byte-range bindings already emitted by the layout probe are sufficient to execute the tied-weight primitive semantics without rebuilding the full 1,050,673,152-byte matrix in one external artifact.

### 2026-09-08 pinned real-artifact run

The immutable Hugging Face revision already used by CI was range-fetched into the four previously recorded preferred payloads. All four full payload hashes matched the existing evidence:

- payload 0: `b783704059e886b1e5438d23c3f9911b0d947c86125501c9071e5bb8f7cebdce`
- payload 1: `6725be963565c84faaf487339c9b6020166077d62ffeae36467ce284c49cafb7`
- payload 2: `21ea80f5829262b36028f32b17ef213090ff27ff708c6baa47277d45a99bff0a`
- payload 3: `b2d23fbe273c8ae5f43c4ac4200613d3c88b0d11d389d2551a47af8649a688e9`

Environment: macOS 26.6.1 arm64, Python `3.12.12`, NumPy `2.5.3`, ONNX `1.18.0`, ONNX Runtime `1.22.0`, `CPUExecutionProvider`. The exact machine-readable report is committed as [`docs/evidence/endpoint-preferred-tile-ort-cpu-20260908.json`](./evidence/endpoint-preferred-tile-ort-cpu-20260908.json). All eight execution tiles passed. For every tile, embedding output was byte-exact against the selected payload rows (`maxAbsDiff=0.0`) and the sparse logits probe was also exact (`maxAbsDiff=0.0`, `maxRelativeDiff=0.0`). Tiles `1`, `3`, `5`, and `7` bind at physical-artifact offset `131,334,144`, so the run also proves non-zero external-data offsets rather than only artifact-prefix reads.

Observed session/run timing is retained in the JSON report as diagnostic data rather than a performance gate; payload pages may already be warm in the OS page cache. In the committed representative run, embedding session creation was at most about `35.38 ms`, logits session creation at most about `378.73 ms`, and the sparse logits run at most about `25.81 ms`. These numbers are machine- and CPU-provider-specific and are **not** browser or WebGPU working-set/latency evidence.

What this closes for S0: the existing 4-way physical payload -> 8-way tile arithmetic is no longer coordinate-only for the primitive tied-weight operators; it has executed against the real pinned payload bytes under ORT CPU.

## Pinned CPU ORT final-norm + tiled-lm-head composition spike

`tools/probe_llama_1b_endpoint_poststage_tiled_ort_cpu.py` moves the diagnostic one level above the primitive tied-weight operations. It first validates the pinned source post-stage topology itself: `SkipSimplifiedLayerNormalization` in the `com.microsoft` domain with the two layer-15 residual inputs, the 2,048-element final-norm weight and pinned epsilon, followed by the source `Transpose(perm=[1,0])` and `MatMul` that produce `logits`. The tied weight and final-norm weight must retain their pinned external-data locations, offsets, shapes, and byte lengths.

The reference graph then executes that validated final norm and the full tied-weight lm-head directly from the pinned source external-data descriptor. The staged graph executes the **same final norm once**, binds the eight diagnostic vocabulary-row weight tiles from the four preferred physical payload descriptors, runs eight logits `MatMul`s, and concatenates their outputs along the vocabulary axis. Before either run, the helper verifies the complete `1,692,672,000`-byte source SHA-256, every full physical payload SHA-256, and independently hashes each payload's exact source byte range so copied payload evidence cannot detach from the pinned source artifact.

### 2026-09-08 pinned real-artifact post-stage run

The exact machine-readable report is committed as [`docs/evidence/endpoint-poststage-tiled-ort-cpu-20260908.json`](./evidence/endpoint-poststage-tiled-ort-cpu-20260908.json). Environment: macOS `26.6.1` arm64, Python `3.12.12`, NumPy `2.5.3`, ONNX `1.18.0`, ONNX Runtime `1.22.0`, `CPUExecutionProvider`. The pinned final-norm weight is `8,192` bytes at source offset `1,084,489,728` with SHA-256 `af89374a4f1edc09ec38496e36efb1663713bc0e44026b8ef9d9d13aac99e75e`.

For one deterministic `[1, 1, 2048]` pair of source post-stage boundary tensors, the reconstructed source-poststage reference and the tiled composition produced **byte-exact** results: final norm `[1,1,2048]` had `maxAbsDiff=0.0`, and complete logits `[1,1,128256]` had `maxAbsDiff=0.0` / `maxRelativeDiff=0.0`. Every one of the eight 16,032-row logits slices was also byte-exact against the corresponding reference vocabulary range. Recorded session creation was about `2.01 s` for the full-weight reference and `3.03 s` for the tiled graph; run times were about `17.3 ms` and `16.8 ms`. These timings are diagnostic CPU observations only and are not performance gates.

What this closes for S0: final norm plus a complete vocabulary-axis tiled lm-head can be composed with the already verified 4-way/8-tile bytes under pinned CPU ORT without a numerical change for the measured boundary input. This is **not** full-model multi-segment equivalence: decoder segmentation, checkpoint relay, KV state, and the embedding pre-stage are not part of this comparison. It also does not select 4-way physical payloads or 8-way execution, and it provides no browser/WebGPU memory, reclamation, or production cache/runtime evidence.

## Pinned browser ORT Web/WebGPU complete post-stage spike

`tools/prepare_llama_1b_endpoint_poststage_tiled_ort_webgpu.py` and `browser-harness/endpoint-poststage-tiled-webgpu/` extend the CPU post-stage composition above into a real browser session without promoting the candidate architecture. Preparation validates the pinned source graph/post-stage topology, verifies the complete source external-data identity, materializes all four existing preferred physical payloads from their exact source ranges, and emits one final-norm graph plus eight logits-tile graphs. A pinned-source CPU ORT full-weight run generates the deterministic reference final-norm and complete logits fixtures consumed by the browser comparison.

The browser validates a hard-coded manifest contract before ORT execution, including source identities, the 8 KiB final-norm range, all four payload SHA-256 values, every tile offset/length, every generated graph digest, deterministic input digests, and CPU reference-output digests. It executes the source `SkipSimplifiedLayerNormalization` once, then processes physical artifacts `0 -> 1 -> 2 -> 3`; each 250.5 MiB payload backs exactly two 125.25 MiB vocabulary tiles and is no longer referenced by the harness after those two sessions finish. `InferenceSession.release()` is awaited for every session. This sequential JavaScript lifetime is an experiment shape only: it is **not** evidence that the browser, ORT, Metal driver, or OS immediately reclaimed the corresponding host/GPU allocations.

### 2026-09-08 real Chrome / Apple Metal complete post-stage run

The machine-readable runtime report is committed as [`docs/evidence/endpoint-poststage-tiled-ort-webgpu-20260908.json`](./evidence/endpoint-poststage-tiled-ort-webgpu-20260908.json). The run used Chrome `152.0.7977.83` headless on macOS `26.6.1` arm64 / Apple M4, ONNX Runtime Web `1.22.0`, with the adapter reporting `vendor=apple`, `architecture=metal-3`. The browser was configured with the WebGPU execution provider; the report does not independently trace provider assignment for each individual node.

Against the pinned-source ONNX Runtime `1.22.0` CPU reference for the same deterministic boundary tensors:

- final norm `[1,1,2048]`: within cross-provider tolerance (`atol=1e-4`, `rtol=1e-4`), `maxAbsDiff=9.5367431640625e-7`, `maxRelativeDiff=1.7643061632242554e-7`;
- complete logits `[1,1,128256]`: within the same cross-provider tolerance, `maxAbsDiff=1.71661376953125e-5`; the maximum relative difference is `0.019190318548857277` at a near-zero reference value, so absolute error is the more useful bound here;
- all eight individual logits tile comparisons also pass the same tolerance;
- all nine `InferenceSession.release()` calls (one final norm plus eight logits sessions) returned.

The tolerance is intentionally looser than the `1e-6` CPU-vs-CPU diagnostic because the comparison crosses providers and GPU reduction order is not expected to be bit-identical. The measured error is retained explicitly rather than described as byte-exact. This closes the narrow S0 question that the complete final-norm + tiled-lm-head post-stage can execute in the real browser harness and remain numerically close to the pinned full-weight CPU reference. It still does **not** prove decoder/KV/checkpoint full-model staged equivalence, embedding-to-decoder composition, peak host/GPU working set, post-release reclamation, browser cold/warm residency behavior, or an approved manifest/cache/loader/runtime/dispatcher design.

## Pinned browser ORT Web/WebGPU preferred-payload range spike

`tools/prepare_llama_1b_endpoint_preferred_tile_ort_webgpu.py` and
`browser-harness/endpoint-tile-webgpu/` close the next narrow S0 question: can
ONNX Runtime Web `1.22.0` execute a tied-weight tile whose initializer points at
an exact byte range **inside** a verified preferred-size physical payload?

The preparation tool re-runs the pinned layout probe, requires the upstream
report to remain `decisionStatus=diagnostic-only`, verifies the complete
`1,692,672,000`-byte source external-data SHA-256, and materializes only
preferred physical artifact 0 (`262,668,288` bytes / `250.5 MiB`). It then emits
four tiny external-data ONNX graphs for execution tiles 0 and 1:

- tile 0: artifact byte offset `0`, length `131,334,144`,
- tile 1: artifact byte offset `131,334,144`, length `131,334,144`,
- each tile has an embedding `Gather` graph and a logits `Transpose + MatMul`
  graph,
- all four graphs name the same `payload-0000.bin`; the ONNX external-data
  metadata, rather than a rebuilt tile file, selects the byte range.

The browser verifies the full physical payload SHA-256 before creating any ORT
session and supplies that full verified object through ORT Web's `externalData`
option. This experiment therefore proves **external-data offset binding inside a
whole verified physical object**. It does not prove HTTP range fetching,
sub-object Cache API residency, or a production streaming strategy.

### 2026-09-08 real Chrome / Apple Metal run

The exact runtime report is committed as
[`docs/evidence/endpoint-preferred-tile-ort-webgpu-20260908.json`](./evidence/endpoint-preferred-tile-ort-webgpu-20260908.json).
The run used Chrome `152.0.7977.83` headless on macOS `26.6.1` arm64 / Apple M4,
with the WebGPU adapter reporting `vendor=apple`, `architecture=metal-3`, and
ONNX Runtime Web `1.22.0`.

Both selected tiles passed against direct references computed from the verified
physical payload bytes:

| tile | artifact offset | embedding | sparse logits |
|---:|---:|---|---|
| 0 | `0` | byte-exact, `maxAbsDiff=0.0` | `maxAbsDiff=0.0`, `maxRelativeDiff=0.0` |
| 1 | `131,334,144` | byte-exact, `maxAbsDiff=0.0` | `maxAbsDiff=0.0`, `maxRelativeDiff=0.0` |

The runtime awaits `InferenceSession.release()` after every embedding/logits
session and records the API completion latency separately. This proves that all
four release calls returned; it does **not** prove that the browser/driver
immediately reclaimed all GPU allocations. Timing is retained only as
diagnostic context because this run does not control OS page-cache state or
measure GPU/host peak memory. The report also records the adapter's exposed
`maxBufferSize` and `maxStorageBufferBindingSize` for the tested device. In the
recorded Apple Metal run both were `4,294,967,292` bytes (with
`maxComputeWorkgroupStorageSize=32,768`), so the 125.25 MiB tile was below the
adapter's exposed single-buffer/storage-binding limits. This is a device-specific
observation, not a cross-device support guarantee.

What this closes for S0: ORT Web/WebGPU is no longer an untested assumption for
the 4-way preferred-payload -> 8-way tile offset mechanism. A real WebGPU
session consumed both a payload-prefix tile and a non-zero-offset tile from the
same 250.5 MiB verified physical payload and produced exact primitive results.

What remains open: this result does **not** select the 4-way layout or 8-way
execution model, does not exercise the 5-way two-physical-slice case in the
browser, does not include final norm or decoder composition, does not prove
full-vs-staged logits equivalence, and does not measure peak host/GPU working
set. Manifest/cache/loader/dispatcher contracts are still unapproved #223
architecture work.

## Pinned browser ORT Web/WebGPU 5-way boundary-crossing spike

`tools/prepare_llama_1b_endpoint_five_way_tile_ort_webgpu.py` and
`browser-harness/endpoint-five-way-tile-webgpu/` close the corresponding browser-side S0 question for one representative 5-way boundary-crossing execution tile. The preparation re-verifies the full pinned external-data identity, materializes whole physical artifacts 0 and 1 directly from their exact source ranges, and emits embedding/logits graphs with two external initializers followed by `Concat(axis=0)`. The browser then verifies both complete physical payload SHA-256 values before constructing ORT sessions and supplies both payloads through ORT Web's `externalData` option.

### 2026-09-08 real Chrome / Apple Metal 5-way run

The exact runtime report is committed as [`docs/evidence/endpoint-five-way-tile-ort-webgpu-20260908.json`](./evidence/endpoint-five-way-tile-ort-webgpu-20260908.json). The run used Chrome `152.0.7977.83` headless on macOS `26.6.1` arm64 / Apple M4, ONNX Runtime Web `1.22.0`, and the WebGPU adapter reported `vendor=apple`, `architecture=metal-3`.

Execution tile 1 crossed the physical-artifact boundary exactly as predicted:

| physical slice | whole artifact bytes | slice offset | slice bytes |
|---|---:|---:|---:|
| artifact 0 | `210,141,184` | `131,334,144` | `78,807,040` |
| artifact 1 | `210,132,992` | `0` | `52,527,104` |

The browser retained and verified `420,274,176` bytes of whole physical dependencies for this tile. Embedding `Gather` was byte-exact (`maxAbsDiff=0.0`) and sparse logits `Transpose + MatMul` was within tolerance with `maxAbsDiff=0.0` / `maxRelativeDiff=0.0`. Both `InferenceSession.release()` calls completed. This proves that ORT Web/WebGPU on the measured device can bind two independently verified external payload objects into one temporary graph and execute the reconstructed tied-weight tile.

This remains diagnostic-only. In particular, it does **not** prove that `Concat` is memory-efficient enough for production: the two whole payloads total about `400.8 MiB`, and ORT may additionally materialize the `125.25 MiB` concatenated tile plus provider-specific copies. No peak host/GPU memory or post-release reclamation was measured. It also does not select the 5-way layout, define Cache API residency, loader/manifest/runtime/dispatcher semantics, include final norm, or prove full-vs-staged logits equivalence.

## Complete post-stage browser process-RSS diagnostic

`tools/capture_endpoint_poststage_webgpu_process_rss.mjs` wraps the complete 4-way-backed browser post-stage harness in a fresh Chrome profile and samples the launched Chrome process tree with the host OS `ps` resident-set-size (RSS) metric. The harness publishes its current diagnostic phase to `window.__unzenEndpointPoststageWebGpuPhase`, so the capture can retain phase-local peaks without changing execution order or forcing GC/memory pressure. Sampling continues for five seconds after the browser has reported `sessionReleaseApiCompleted=true`, which means the final-norm session and all eight logits-tile `InferenceSession.release()` promises have returned.

The exact machine-readable report from the 2026-09-08 Apple M4 / Chrome 152 run is committed as [`docs/evidence/endpoint-poststage-webgpu-process-rss-20260908.json`](./evidence/endpoint-poststage-webgpu-process-rss-20260908.json). At a 100 ms sampling interval, the sum of RSS across the isolated Chrome root and discovered descendants was:

| observation | summed process RSS | delta from clean `about:blank` baseline |
|---|---:|---:|
| clean isolated Chrome baseline | `1,193,472 KiB` (`1,165.50 MiB`) | — |
| sampled global peak | `3,032,544 KiB` (`2,961.47 MiB`) | `+1,795.97 MiB` |
| immediately after all nine release promises returned | `2,561,040 KiB` (`2,501.02 MiB`) | `+1,335.52 MiB` |
| five seconds after the release-complete report | `2,484,240 KiB` (`2,426.02 MiB`) | `+1,260.52 MiB` |

The sampled global peak occurred while executing logits tile 4. The process-role breakdown at that sample was browser `223,792 KiB`, GPU process `247,696 KiB`, network utility `88,848 KiB`, other utility `63,872 KiB`, and renderers `2,408,336 KiB`. The final five-second sample remained roughly `1.23 GiB` above the clean baseline, so this run provides **no evidence of prompt process-RSS return to baseline after `release()`**. Conversely, the metric cannot establish that the retained RSS is live ORT/WebGPU model memory: Chrome allocators may retain reusable pages and the process sum may count shared mappings more than once.

This is deliberately a coarse residency envelope, not a GPU-memory meter. On Apple unified memory, RSS cannot distinguish CPU-only pages from GPU-visible shared allocations; `ps` cannot identify Metal/WebGPU provider allocations; summed per-process RSS can double-count shared pages; and a five-second observation without forced GC or allocator flush cannot prove eventual reclamation or a leak. The diagnostic therefore narrows #223 by showing the measured process-tree envelope and the lack of immediate baseline recovery, but it does not set a production memory budget or select a physical/execution layout.

## Pinned CPU ORT 5-way boundary-crossing spike

`tools/probe_llama_1b_endpoint_five_way_tile_ort_cpu.py` targets the remaining CPU-side multi-physical-slice question for the diagnostic 5-way layout. The 5-way physical artifacts remain the deterministic balanced row ranges from the layout probe (maximum `210,141,184` bytes, about `200.40625 MiB`), while four of the eight execution tiles cross one physical-artifact boundary. For those tiles, the helper opens both payloads independently and exposes each slice as its own ONNX external initializer. A temporary ONNX graph performs `Concat(axis=0)` on the two slice tensors before the same embedding `Gather` or logits `Transpose + MatMul` primitive is evaluated. The full tied weight is never rebuilt as one external artifact.

Unlike the 4-way spike, the five payload SHA-256 values are not accepted as an independent hard-coded source of truth. The helper first verifies the complete pinned external-data file (`1,692,672,000` bytes, SHA-256 `07cc629ef2cb7fdb18615ce2e4f3774f763e6fc840207d772a8b511eead36647`) through a pinned file descriptor. It then hashes each required 5-way source range directly from that verified descriptor and requires the corresponding standalone payload to match that independently derived range digest, size, and pinned path identity. This keeps the execution evidence bound to the original pinned artifact rather than only to previously copied files.

### 2026-09-08 pinned real-artifact 5-way run

The exact machine-readable report is committed as [`docs/evidence/endpoint-five-way-tile-ort-cpu-20260908.json`](./evidence/endpoint-five-way-tile-ort-cpu-20260908.json). The verified physical payloads were:

- payload 0: `210,141,184` bytes, SHA-256 `3e7e1625498180fc107d572f65bfbb57fef091002fd05990c693b338e2d8edbe`
- payload 1: `210,132,992` bytes, SHA-256 `b1dd6fe5c5668e8e63e597a6cbe6629093dd724b34d82b89ea9715566db93adf`
- payload 2: `210,132,992` bytes, SHA-256 `a8e3d8f54878b7d4285eb1ca59468bc36076d11f9fb27b25afdf170890480f8b`
- payload 3: `210,132,992` bytes, SHA-256 `145c2536a9bbe78212f104b7f7341e1f0c18bbca46b5cf05f314fe313890b3a9`
- payload 4: `210,132,992` bytes, SHA-256 `23c60d265df609f60a48562ca6d2d01f4fc921e507d22975afe7317b66e383c5`

All four boundary-crossing tiles (`1`, `3`, `4`, `6`) passed under ONNX Runtime `1.22.0` `CPUExecutionProvider`. Embedding was byte-exact and sparse logits had `maxAbsDiff=0.0` / `maxRelativeDiff=0.0` for every tile. The exact two-source bindings were:

| tile | first physical slice | second physical slice |
|---:|---|---|
| 1 | artifact 0 offset `131,334,144`, length `78,807,040` | artifact 1 offset `0`, length `52,527,104` |
| 3 | artifact 1 offset `183,861,248`, length `26,271,744` | artifact 2 offset `0`, length `105,062,400` |
| 4 | artifact 2 offset `105,062,400`, length `105,070,592` | artifact 3 offset `0`, length `26,263,552` |
| 6 | artifact 3 offset `157,597,696`, length `52,535,296` | artifact 4 offset `0`, length `78,798,848` |

This closes the **CPU primitive feasibility** question for a logical execution tile assembled from two independently stored physical payloads. By itself this CPU run does not demonstrate that `Concat` is an acceptable production execution strategy: ORT may materialize an additional contiguous tensor, and the resulting host/GPU working set has not been measured. The separate real-browser 5-way spike above establishes browser/WebGPU primitive supply for one crossing tile, while the separate CPU post-stage spike establishes final-norm + complete tiled-lm-head equivalence for the 4-way candidate. Neither result selects the 5-way architecture, defines browser cache/runtime semantics, measures working set/reclamation, or proves full-model multi-segment equivalence.

## Running the probes

From `LLM-proto/`:

```bash
python tools/probe_llama_1b_endpoint_layout_candidates.py \
  /absolute/path/to/model_q4.onnx

python tools/probe_llama_1b_endpoint_dependency_closure.py \
  /absolute/path/to/model_q4.onnx

python tools/probe_llama_1b_endpoint_preferred_tile_ort_cpu.py \
  /absolute/path/to/model_q4.onnx \
  /absolute/path/to/preferred-payload-dir \
  --all-tiles

python tools/probe_llama_1b_endpoint_five_way_tile_ort_cpu.py \
  /absolute/path/to/model_q4.onnx \
  /absolute/path/to/model_q4.onnx_data \
  /absolute/path/to/five-way-payload-dir

python tools/probe_llama_1b_endpoint_poststage_tiled_ort_cpu.py \
  /absolute/path/to/model_q4.onnx \
  /absolute/path/to/model_q4.onnx_data \
  /absolute/path/to/preferred-payload-dir

python tools/prepare_llama_1b_endpoint_preferred_tile_ort_webgpu.py \
  /absolute/path/to/model_q4.onnx \
  /absolute/path/to/model_q4.onnx_data \
  /tmp/unzen-endpoint-webgpu-data

DATA_DIR=/tmp/unzen-endpoint-webgpu-data PORT=8793 \
  node browser-harness/endpoint-tile-webgpu/serve.mjs

python tools/prepare_llama_1b_endpoint_five_way_tile_ort_webgpu.py \
  /absolute/path/to/model_q4.onnx \
  /absolute/path/to/model_q4.onnx_data \
  /tmp/unzen-endpoint-five-way-webgpu-data

DATA_DIR=/tmp/unzen-endpoint-five-way-webgpu-data PORT=8794 \
  node browser-harness/endpoint-five-way-tile-webgpu/serve.mjs

python tools/prepare_llama_1b_endpoint_poststage_tiled_ort_webgpu.py \
  /absolute/path/to/model_q4.onnx \
  /absolute/path/to/model_q4.onnx_data \
  /tmp/unzen-endpoint-poststage-webgpu-data

DATA_DIR=/tmp/unzen-endpoint-poststage-webgpu-data PORT=8795 \
  node browser-harness/endpoint-poststage-tiled-webgpu/serve.mjs

# Or launch an isolated Chrome instance and capture the diagnostic process-RSS envelope.
node tools/capture_endpoint_poststage_webgpu_process_rss.mjs \
  /tmp/unzen-endpoint-poststage-webgpu-data \
  /tmp/endpoint-poststage-webgpu-process-rss.json

# In another shell, use a fresh browser profile and open the matching URL above
# (8793, 8794, or 8795). The recorded macOS runs used Chrome 152; for example:
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --user-data-dir=/tmp/unzen-endpoint-webgpu-chrome \
  --disable-gpu-sandbox --enable-unsafe-webgpu \
  http://127.0.0.1:8793/
```

All eight Python commands ultimately invoke the pinned endpoint chunk-envelope probe. A source graph identity, pinned external-data identity, or tied embedding/logits geometry drift therefore fails before candidate geometry is emitted.

The layout JSON report includes the upstream probe/source identity and, for every candidate:

- exact physical row ranges and source-byte ranges,
- exact 8-way execution row and source-byte ranges,
- per-tile physical slices with physical-artifact-relative and source-relative byte offsets,
- maximum physical payload bytes,
- maximum execution-tile bytes,
- preferred-ceiling comparison,
- distance from the 200 MiB target,
- total slice reads implied by the arithmetic mapping,
- whether the eight tile source ranges cover the tied weight exactly,
- whether each execution tile is contained within one physical payload,
- whether execution and physical boundaries align exactly.

The dependency-closure JSON report preserves the same source identity and adds, per candidate and tile:

- required physical-artifact indices/count,
- execution-tile bytes,
- full physical-artifact dependency bytes,
- bytes inside those required full artifacts not consumed by the tile,
- numeric distance from the current preferred physical-artifact reference, explicitly not an execution-policy verdict.

CI runs the arithmetic layout/dependency probes against the same pinned Llama 1B graph used by the existing budget blocker and endpoint-envelope probes. The CPU ORT tile and post-stage composition helpers are covered by synthetic external-data unit tests but are not run against the 1.0+ GiB real endpoint payloads on every CI run; the pinned real-payload reports above are committed as diagnostic evidence rather than promoted to CI performance gates.

## Evidence boundary

The arithmetic probes prove only that the pinned graph still yields the recorded source-row/byte geometry under the recorded source identity, that the candidate range mappings are internally exact, and that whole-artifact dependency-closure arithmetic is internally consistent. A passing 4-way CPU ORT tile run additionally proves the selected primitive `Gather` and `Transpose + MatMul` executions consume the pinned 4-way payload byte ranges correctly under the pinned CPU provider. The 5-way boundary-crossing run additionally proves that two independently verified physical source ranges can be supplied as separate external initializers, concatenated into one execution-tile tensor inside ORT CPU, and consumed with the same primitive numerical result. The post-stage CPU run further proves that the pinned final norm and all eight 4-way-backed vocabulary logits tiles can be composed into the complete `[1,1,128256]` logits tensor with byte-exact output against a source-topology/full-weight reference for the measured boundary input. The complete browser post-stage run further demonstrates the same final norm plus all eight 4-way-backed logits tiles in a real ORT Web session configured for WebGPU, processing the four verified physical payloads sequentially and staying within the recorded cross-provider numerical tolerance against that pinned CPU reference.

It does **not** prove:

- that all 4/5/8 candidate layouts have been fully materialized and independently verified as production artifacts,
- that multiple physical artifacts are an approved manifest/cache contract,
- that ORT Web range binding avoids hidden provider-side copies or yields a bounded host/GPU working set,
- that the demonstrated CPU-side two-payload `Concat` strategy is acceptable or bounded under ORT Web/WebGPU,
- that physical dependency-closure bytes equal resident host/GPU memory,
- that the physical payload count should be 4, 5, or 8,
- that an 8-way execution plan should be adopted,
- that peak host/GPU working set is acceptable,
- that browser cold/warm latency is acceptable,
- that the complete embedding/decoder/final-norm/logits staged pipeline is numerically equivalent to the full model, especially under ORT Web/WebGPU,
- that a normal short-lived visitor should run endpoint stages.

Those remain explicit #223 decision and S0 feasibility gates. Runtime, manifest, loader, cache, residency, dispatcher, and artifact-policy behavior remain unchanged by these probes.
