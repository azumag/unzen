# Real two-segment WebGPU E2E (#165)

## Why this is P0

LLM-proto already has a real single-browser WebGPU measurement for
`onnx-community/Llama-3.2-1B-Instruct` q4 and extensive Coordinator / operations
contracts. The missing technical-core proof is still the real segmented path:

```text
Browser A (layers 0..7 + segment-0 weights only)
  -> two measured boundary tensors
  -> Coordinator relay
  -> Browser B (layers 8..15 + final norm + lm_head + segment-1 weights only)
  -> logits / one continuation token
```

Continuous Assurance production deployment #158 is intentionally held until
this path is demonstrated with real model artifacts and two distinct browser
workers.

## What this change automates

The automated part stops immediately before the real 1.7 GB q4 source artifact
and a WebGPU browser are required.

### 1. Deterministic graph split

`tools/split_llama_1b_onnx.py` loads the source ModelProto with
`load_external_data=False`, discovers the two tensors produced by layer 7 and
consumed by layer 8's `input_layernorm`, and extracts two dependency-closed
subgraphs without loading the large q4 tensor payload into Python memory.

The splitter fails closed unless:

- exactly one layer-8 input-layernorm node is found;
- exactly two inputs to that node are produced by layer 7;
- exactly one `logits` graph output exists.

### 2. Per-segment external weight repack

`tools/prepare_real_split.py` wraps the graph splitter and then streams only the
external-data byte ranges referenced by each segment into its own weight file.
It rewrites every selected TensorProto `location` / `offset` / `length`, so the
browser does **not** need to download or mount the original full-model external
data blob for both workers.

Output:

```text
unzen-split/
  segment0.onnx
  segment0.onnx_data
  segment1.onnx
  segment1.onnx_data
  split-manifest.json
```

The manifest records:

- source model / source external-data SHA-256;
- segment graph SHA-256;
- each segment-specific external-data SHA-256 and byte size;
- exact boundary tensor names and producer nodes;
- expected float32 boundary bytes per token;
- `artifactLayout: "per-segment-external-data"`.

The repacker copies ranges in bounded chunks and does not materialize the full
1.7 GB source weights in Python memory.

### 3. Same-machine correctness verifier

`tools/verify_split_onnx.py` runs:

```text
full model -> logits
segment 0 -> boundary tensors -> segment 1 -> logits
```

with the exact same token IDs. It compares the complete logits tensor with
configurable `atol` / `rtol` and separately requires the final-position top-1
token ID to match.

The tool accepts token IDs instead of adding another tokenizer dependency. Copy
the IDs reported by the browser harness into `--input-ids`. It creates empty
KV-cache tensors from ONNX Runtime input metadata using the measured
Llama-3.2-1B defaults (8 KV heads, head size 64).

### 4. Two-browser Coordinator relay harness

`browser-harness/webgpu-2b-split/serve.mjs` is a local Coordinator and static
server. It never creates a browser-to-browser route.

`runner-v2.js` uses ONNX Runtime WebGPU and explicitly supplies each segment's
`externalData` entries when creating the session. ONNX Runtime Web requires this
for models whose tensors live in external files. Each browser therefore mounts
only its own repacked segment data file.

Open two distinct browser profiles/windows with the same `run` ID:

```text
http://127.0.0.1:8791/?role=segment0&run=trial-1
http://127.0.0.1:8791/?role=segment1&run=trial-1
```

The first browser runs `segment0.onnx`, serializes the two real boundary tensors,
and POSTs them to the Coordinator. The second browser polls the Coordinator,
reconstructs those tensors, runs `segment1.onnx`, and reports the top-1
continuation token.

For worker-loss/resume verification, replace the second worker after the
checkpoint exists:

```text
http://127.0.0.1:8791/?role=standby&run=trial-1&worker=browser-b-standby
```

The checkpoint remains Coordinator-owned, so the standby can continue without
rerunning segment 0.

## Automated CI gate

The Python test creates a tiny Llama-shaped ONNX fixture with one shared external
weight file, then performs the same production preparation path:

1. split the graph;
2. repack segment-specific external data;
3. prove each segment weight file is smaller than the source full weight file;
4. verify the segment graph locations point only at their own data file;
5. execute full and split graphs with ONNX Runtime;
6. require exact logits equality and identical top-1 token;
7. mutate the layer-8 boundary and prove the splitter fails closed.

The Vitest Coordinator test proves:

- distinct worker registration;
- exactly two boundary tensors are stored and fetched through Coordinator state;
- direct worker-to-worker networking returns HTTP 403;
- a standby worker can consume the already-stored checkpoint and submit a
  resumed result.

CI also syntax-checks the Node Coordinator and browser runner.

Focused commands:

```bash
cd LLM-proto
python3 -m unittest discover -s tools/tests -p 'test_*.py'
npm test -- --run tests/real-two-browser-coordinator.test.ts
node --check browser-harness/webgpu-2b-split/runner-v2.js
```

## Real verification procedure

### Prerequisites

Keep the already-downloaded q4 model tree outside git. The expected source is
the same model measured in the existing single-browser harness:

```text
<MODEL_ROOT>/
  onnx/model_q4.onnx
  onnx/model_q4.onnx_data
  ... tokenizer/config files ...
```

Install the local tooling:

```bash
cd LLM-proto
python3 -m venv .venv-real-split
. .venv-real-split/bin/activate
pip install -r tools/requirements-real-split.txt
```

### A. Prepare real browser-ready split artifacts

```bash
python3 tools/prepare_real_split.py \
  /absolute/path/to/onnx/model_q4.onnx \
  /absolute/path/to/unzen-split
```

This is expected to produce two ONNX graphs plus two independent external weight
files. Do not proceed if either segment still references the original full data
file.

The command fails before claiming success if:

- the real layer-8 graph no longer exposes the measured two-tensor boundary;
- an external-data range lacks a safe location or explicit length;
- a source range cannot be copied completely;
- either output graph fails ONNX validation.

### B. Obtain exact input IDs and run same-machine full-vs-split logits

Serve the prepared split directory:

```bash
MODELS_DIR=/absolute/path/to/unzen-split \
  node browser-harness/webgpu-2b-split/serve.mjs
```

Open the segment-0 URL once and copy the `input token ids:` line. Then run:

```bash
python3 tools/verify_split_onnx.py \
  --full-model /absolute/path/to/onnx/model_q4.onnx \
  --segment0 /absolute/path/to/unzen-split/segment0.onnx \
  --segment1 /absolute/path/to/unzen-split/segment1.onnx \
  --manifest /absolute/path/to/unzen-split/split-manifest.json \
  --input-ids '128000,791,...'
```

This is the first **real verification boundary**. A pass requires both numeric
logits tolerance and top-1 token equality.

### C. Run two distinct WebGPU browser workers

With the same local Coordinator running, open these URLs in two distinct Chrome
profiles (or on two machines that can reach the Coordinator):

```text
http://127.0.0.1:8791/?role=segment0&run=trial-1
http://127.0.0.1:8791/?role=segment1&run=trial-1
```

Click `Execute role` in segment 0, then segment 1.

The segment-1 report must include:

- two distinct worker IDs;
- `artifactLayout: "per-segment-external-data"`;
- segment-specific external-data metadata;
- `relayOwner: "coordinator"`;
- `directWorkerNetworking: false`;
- observed boundary byte count;
- segment 0 and segment 1 execution time;
- logits shape;
- top-1 token ID/text;
- WebGPU adapter metadata.

### D. Real worker-loss resume

1. Run segment 0 and wait for the Coordinator receipt.
2. Close/kill the intended segment-1 primary before it executes.
3. Open a `role=standby` browser using the same `run` ID.
4. Execute the standby.
5. Confirm the result references the original segment-0 worker/checkpoint and no
   second segment-0 execution occurred.

## Evidence status

Passing CI proves the split/repack algorithm on an external-data ONNX graph,
numeric full-vs-split equivalence on that fixture, and Coordinator relay
semantics. It does **not** claim that the real Llama-3.2-1B q4 model has already
been split or that two real browsers have executed it.

The first real browser report is `self-reported-runtime`. Promotion to
`captured-and-verified` should reuse the existing `EvidenceEnvelope` only after
artifact capture, digest verification, environment metadata, and an independent
verifier are available.
