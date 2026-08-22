# 2B / 2-Worker Prototype Specification

## Purpose

This document defines the first executable LLM-proto milestone before the
larger 30B-class pipeline in `PLAN.md`.

The long-term target is to run large open-weight LLMs such as gpt-oss-120b or
GLM-4.7-class models across many browser workers. That target is too large for
the first validation loop. The first milestone is therefore a 2B-class model
split across exactly two workers, with enough instrumentation to decide whether
the architecture should scale up.

## Scope

| Item | Prototype target | Out of scope |
|---|---|---|
| Model size | 2B-class causal LM | 30B/70B/120B production routing |
| Split count | 2 contiguous model segments | Adaptive multi-span scheduling |
| Worker count | 2 active browser workers + optional standby retry worker | Large public worker marketplace |
| Execution backend | WebGPU first, CPU only for diagnostics | CPU-only production serving |
| Transport | Coordinator-mediated messages only | Worker-to-worker WebRTC/direct third-party links |
| Persistence | IndexedDB weight cache + Coordinator checkpoint cache | Durable global model registry |

## Architecture

```text
API client
  |
  v
Coordinator
  | assign segment 0
  v
Worker A: layers 0..N/2-1
  | hidden-state checkpoint through Coordinator
  v
Worker B: layers N/2..N-1
  |
  v
Coordinator returns generated token/logits
```

The prototype keeps the same safety boundary as `PLAN.md`: browser workers only
communicate with unzen-managed Coordinator/CDN endpoints. The Coordinator owns
assignment, heartbeat, checkpoint relay, retry, and result assembly.

## Model Packaging

The selected 2B-class model must be converted into two contiguous artifacts:

| Artifact | Contents | Expected cache location |
|---|---|---|
| `model-seg-0` | embedding + first half of transformer layers | IndexedDB `unzen:model:<modelId>:seg0` |
| `model-seg-1` | second half of transformer layers + output head | IndexedDB `unzen:model:<modelId>:seg1` |

Each artifact must include a manifest entry:

```json
{
  "modelId": "proto-2b-q4",
  "segmentIndex": 0,
  "totalSegments": 2,
  "layerStart": 0,
  "layerEnd": 7,
  "quantization": "q4",
  "sha256": "..."
}
```

(The example matches the 16-layer Llama-3.2-1B split at the layer-7/8
boundary used in the split-path design notes below. The exact layer count
depends on the selected model.)

The exact layer count depends on the selected model. Segment boundaries should
be contiguous and deterministic; uneven splits are allowed only when required by
embedding/output-head placement or WebGPU memory limits.

## Coordinator Contract

The Coordinator must support these message-level capabilities before the
prototype is considered complete:

1. Register a worker with WebGPU capability, approximate VRAM budget, and cached
   segment inventory.
2. Assign segment 0 and segment 1 to two distinct active workers.
3. Forward the hidden-state checkpoint from worker A to worker B without exposing
   worker-to-worker direct connectivity.
4. Detect heartbeat loss and retry from the latest checkpoint on a standby
   worker.
5. Record latency, transfer size, GPU adapter metadata, retry count, and final
   token/logit result for each request.

## Acceptance Criteria

The first implementation milestone is complete when all of the following are
true:

- A 2B-class model can produce at least one continuation token through the
  two-worker split path.
- The same prompt can be run through a single-worker reference path and compared
  against the split path within a documented tolerance.
- Segment artifacts are cached in IndexedDB and reused on a second run.
- Killing worker B after worker A has checkpointed resumes from the checkpoint
  instead of restarting segment 0.
- The run report captures latency per segment, checkpoint byte size, cache hit
  status, retry count, and WebGPU adapter metadata.
- No browser worker opens a network connection outside the configured unzen
  Coordinator/CDN allowlist.

## Executable Harness

`src/two-worker-prototype.ts` provides a simulated harness for this milestone
before real 2B weights are practical in CI. It fixes the topology to segment 0
worker, segment 1 primary worker, and a segment 1 standby worker. The harness
runs the same prompt through:

1. `runReferencePath`, a single-process deterministic reference.
2. `TwoWorkerPrototypeRunner`, the split path with a Coordinator-relayed
   checkpoint.

The fake segment artifacts are enough to test the acceptance-control flow:

- Segment 0 produces a hidden-state checkpoint and reports checkpoint bytes.
- Segment 1 consumes the relayed checkpoint and emits the continuation text.
- The first segment 1 worker can be configured to fail once; the standby worker
  resumes from the existing checkpoint instead of rerunning segment 0.
- Workers use `AllowlistedPrototypeTransport`, which only accepts configured
  Coordinator/CDN origins and rejects direct worker-to-worker URLs.
- Running the same runner twice records cold then warm cache-hit status for the
  fixed two segment artifacts.

Run the focused harness tests with:

```bash
cd LLM-proto
npm test -- --run tests/two-worker-prototype.test.ts
```

Each `PrototypeRunReport` contains:

| Field | Meaning |
|---|---|
| `referenceText` / `splitText` | Single-worker reference output and split-path output |
| `matchesReference` | Whether the two paths match for the prompt |
| `checkpointRelayBytes` | Hidden-state bytes relayed through the Coordinator |
| `segments[].latencyMs` | Per-segment execution latency |
| `segments[].cacheHit` | Whether the worker already held the segment artifact |
| `segments[].retryCount` | Retry count for the segment, including segment-1 resume |
| `segments[].workerMetadata` | Mock WebGPU adapter, tier, VRAM, and cached segments |
| `transport.connections` | Coordinator/CDN origins touched by simulated workers |

## Scale-Up Gate

Do not move from this prototype to 30B-class work until the run report answers:

| Question | Required evidence |
|---|---|
| Is the checkpoint small enough? | Measured hidden-state byte size and transfer time |
| Is WebGPU execution stable? | Browser/adapter matrix with pass/fail and crash notes |
| Is retry useful? | Demonstrated resume after segment-1 worker loss |
| Is cache practical? | Cold vs warm load timing for both segments |
| Is quality preserved? | Split-path output comparison against reference execution |

If any gate fails, the next issue should target that bottleneck directly instead
of increasing model size or worker count.

## Single-worker reference measurement (2026-08-06)

The first real-browser measurement milestone: a 1B-class model run through the
WebGPU backend as the single-worker reference path (the split path is the next
milestone). Self-reported, not yet captured-and-verified.

### Remote-artifact run (first measurement)

| Item | Cold (first load) | Warm (browser Cache API) |
|---|---|---|
| Model | onnx-community/Llama-3.2-1B-Instruct (q4, ~1.7 GB ONNX data) | same |
| Browser / adapter | Chrome 150.0.7871.188, macOS 26.5.2 arm64, Apple GPU (metal-3) | same |
| Load time | 2,562,494 ms (~43 min: 1.7 GB download at a variable ~0.5-0.7 MB/s + WebGPU compile) | 15,721 ms |
| Generation (32 tokens, greedy) | 12,115 ms (~2.6 tok/s) | 24,394 ms (~1.3 tok/s) |
| Output sample | "The capital of France is Paris. The capital of Germany is Berlin…" | same |

These two generation readings were taken as single samples while the browser
was also handling the 1.7 GB artifact stream; they are diagnostic only and not
used for the throughput estimate.

### Local-artifact runs (model served from disk, verified)

The 1.7 GB q4 artifacts are served by the harness itself
(`MODELS_DIR=... node serve.mjs`, `env.localModelPath='/models/'` +
`env.allowLocalModels=true`). The server access log recorded the
`/models/.../model_q4.onnx_data` requests, so the local path was actually
used. Five runs on a fresh browser profile:

| Run | Load (local cache hit + compile) | Generation (32 tokens) | tok/s |
|---|---|---|---|
| 1 | 6,610 ms | 3,026 ms | 10.6 |
| 2 | 5,478 ms | 2,034 ms | 15.7 |
| 3 | 4,688 ms | 1,608 ms | 19.9 |
| 4 | (from the same session) | 4,713 ms | 6.8 |
| 5 | (from the same session) | 2,304 ms | 13.9 |

Same output text in every run. Generation throughput: **6.8-19.9 tok/s**
(32 tokens, greedy), mean ~13 tok/s across these five samples.

Findings:

- A 1B-class model produces correct continuation text on the real WebGPU path
  in this environment (device precondition proven).
- **Generation throughput is 6.8-19.9 tok/s (32 tokens, greedy) when the model
  is served locally.** The remote-artifact readings (1.3-2.6 tok/s) are not
  used for the estimate (see above).
- Load from local artifacts + WebGPU compile is ~5-7 s per run; the first
  remote load was 43 min, dominated by the download. The browser Cache API
  shortens a remote reload to ~16 s.
- This single-worker run does not yet cover: two-segment split execution,
  checkpoint relay, worker-loss resume, or split-vs-reference quality
  comparison (see `Executable Harness` above for the simulated control flow).

Harness: `browser-harness/webgpu-2b/` (serve with
`MODELS_DIR=<dir> node serve.mjs` to serve local model artifacts, open
`index.html?model=<repo>` and click Run; the report is rendered on the page).
The runner loads transformers.js from a pinned jsdelivr URL and model
artifacts from the local `/models/` path or huggingface.co — fine for a local
diagnostic harness, but a telemetry path would need to vendor the library with
SRI and serve artifacts
from the unzen CDN.

## Split-path design notes (2026-08-06)

ONNX graph analysis of `onnx-community/Llama-3.2-1B-Instruct`
(`onnx/model_q4.onnx`, opset 21 + com.microsoft) to prepare the two-segment
split implementation. The graph was NOT split yet; these notes fix the
boundary contract the split must honor.

### Graph structure (measured)

| Item | Value |
|---|---|
| Decoder layers | 16 (`/model/layers.0` .. `/model/layers.15`) |
| Hidden size | 2048 (float32) |
| KV cache | 16 layers x 8 heads x 64 dims (`past_key_values.N.key/value`) |
| Attention mask | computed by a shared subgraph (`/model/attn_mask_reformat/...`) from `attention_mask` + sequence length |
| RoPE | `cos_cache` / `sin_cache` are graph INITIALIZERS in the external data file (`model_q4.onnx_data`), shape `[131072, 32]` float32 (~16 MB each), consumed by every `GroupQueryAttention` node |
| LM head | `final_norm_layernorm` (inside `/model/layers.16/`) + `lm_head` MatMul → `logits [batch, seq, 128256]` |

### Layer boundary

Each layer N starts with `SkipSimplifiedLayerNormalization`
(`/model/layers.N/input_layernorm/SkipLayerNorm`), which fuses the residual
add. The `GroupQueryAttention` node takes NO residual input: the residual
chain is carried by the SkipLayerNorm outputs (`output_3` = residual path,
`output_0` = normalized path). Verified wiring into layer 8's input norm:

- `output_3` of layer 7's `post_attention_layernorm` (the layer-7 residual
  chain state), and
- `output_0` of layer 7's `mlp/down_proj` (the MLP result),

both `[batch_size, sequence_length, 2048]` float32, are added + normalized by
layer 8's `input_layernorm`. A clean layer-7/8 boundary therefore relays
**2 tensors per token (residual + MLP output, 16 KiB/token)**; there is no
single-tensor boundary because of the fused residual chain. (An alternative —
slicing after layer 8's `input_layernorm` — still needs the normalized output
AND the residual output, so it stays 2 tensors.)

### Checkpoint (relayed hidden state) size estimate

The boundary relays two `[batch_size, sequence_length, 2048]` float32 tensors
(residual + MLP output) per layer boundary. At batch 1: **16 KiB per token**
(2 x 2048 x 4 B), so a 32-token prefix relay costs **512 KiB** and each
decoded token relays 16 KiB. This is the size the Coordinator must relay per
step in the split path — to be confirmed by the split run.

### Split approach (recommended)

Two onnxruntime-web sessions over the SAME q4 artifact file, produced by
slicing the ONNX graph (e.g. python `onnx.utils.extract_model` on the
`model_q4.onnx` + external data):

- **Segment 0**: inputs `input_ids` + `attention_mask` + `past_key_values.0..7` +
  `cos_cache` / `sin_cache`; embedding + attention-mask subgraph +
  `/model/layers.0` .. `/model/layers.7`; outputs the layer-7 residual
  (`post_attention_layernorm` `output_3`) + layer-7 MLP result
  (`mlp/down_proj` `output_0`) + `present.0..7`.
- **Segment 1**: `/model/layers.8` (input_layernorm onward) ..
  `/model/layers.16` (incl. final norm) + `lm_head`; inputs the two boundary
  tensors + `past_key_values.8..15` + `attention_mask` + `cos_cache` /
  `sin_cache`; outputs `logits` + `present.8..15`.

Generation loop (self-implemented, transformers.js not used for execution):
prefill segment 0 then 1 once, then per-token segment 0 -> relay hidden state
-> segment 1 -> sample.

### Open questions before implementing

- Weight tensors live in the shared external data file (`model_q4.onnx_data`);
  both sliced models must reference it (no re-export needed if the initializer
  names are preserved).
- `cos_cache` / `sin_cache` are large initializers (each ~16 MB); both sliced
  models reference them from the shared external data file, so the file must
  stay co-located with both sliced `.onnx` files.
- The attention-mask subgraph must be duplicated into segment 1 or the mask
  tensor must be precomputed by the caller and passed in as a graph input.
- KV-cache ownership: segment 0 owns layers 0-7 cache, segment 1 owns 8-15;
  the Coordinator relays only the two boundary tensors (16 KiB/token), not the
  caches.
- Quality gate: split-path logits must match the single-worker reference
  within tolerance (the reference path is measured above).


## Split-path browser measurement (2026-08-22)

The first real-browser split-path run used the local Llama-3.2-1B q4 segments.
It intentionally skipped the full-model reference session with `full=0`, so it
proves that the split graph executes and generates on WebGPU; it does not prove
a same-browser split/full quality comparison. The Python split-vs-full check
from 2026-08-08 remains the recorded quality evidence for these artifacts.

### Low-load run (self-reported)

| Item | Value |
|---|---|
| Model | `onnx-community/Llama-3.2-1B-Instruct` q4, layer 7/8 boundary |
| URL | `/index-split.html?full=0&tokens=1` |
| Browser / adapter | Codex in-app Chromium, Apple GPU (`metal-3`) |
| Session load | 273,398 ms |
| Split execution | 5,419 ms after sessions were ready |
| Output | `" Paris"` for prompt `The capital of France is` |
| Relay | 98,304 bytes total / per prefill step |
| Report status | `ok: true`; `referenceSkipped: true` |

The 273-second load includes reading both ~1.3 GB external-data files and
WebGPU compilation. It was deliberately a one-token run to keep GPU and memory
load low. The report is self-reported diagnostic evidence, not yet wrapped in a
captured-and-verified EvidenceEnvelope.

### Harness commands

```bash
# Serve harness and trusted model artifacts on loopback only.
cd LLM-proto/browser-harness/webgpu-2b
MODELS_DIR=/Volumes/satelite/llm-models/webgpu-models PORT=8788 node serve.mjs

# Open the low-load split-only path:
# http://127.0.0.1:8788/index-split.html?full=0&tokens=1
```

### Segment regeneration contract

Use ONNX Runtime's Python package and slice the full q4 graph with explicit
input/output names. Keep the generated `.onnx` files beside the existing shared
`model_q4.onnx_data` so their initializers resolve without copying weights.

Segment 0 inputs are `input_ids`, `attention_mask`,
`past_key_values.{0..7}.key/value`. Its outputs are the two boundary tensors,
`/model/layers.7/post_attention_layernorm/output_3`,
`/model/layers.7/mlp/down_proj/MatMul/output_0`, plus
`present.{0..7}.key/value`.

Segment 1 inputs are those two boundary tensors, `attention_mask`, and
`past_key_values.{8..15}.key/value`. Its outputs are `logits` plus
`present.{8..15}.key/value`.

A reproducible script should enumerate the exact names above into two lists and
call:

```python
onnx.utils.extract_model(
    "model_q4.onnx",
    "segment0.onnx",
    segment0_inputs,
    segment0_outputs,
)
onnx.utils.extract_model(
    "model_q4.onnx",
    "segment1.onnx",
    segment1_inputs,
    segment1_outputs,
)
```

After generation, compare full-model logits with segment 0 followed by segment
1 over at least one real prompt before treating the artifacts as usable. Record
the maximum absolute difference alongside the artifact revisions/hashes.


## Relationship To Existing Designs

- `PLAN.md` remains the reviewed long-term pipeline plan for 30B-class models.
- `SWARM.md` remains a complementary light-model ensemble design; it is not the
  execution path for this two-worker split milestone.
- Existing TypeScript modules under `src/` model the Coordinator, WorkerPool,
  checkpoint, and span-routing concepts. This spec narrows the first runnable
  milestone to two fixed segments before adaptive routing is introduced.
