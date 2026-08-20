# Real two-segment WebGPU E2E (#165)

## Why this is P0

LLM-proto already has a real single-browser WebGPU measurement for
`onnx-community/Llama-3.2-1B-Instruct` q4 and extensive Coordinator / operations
contracts. The missing technical-core proof is still the real segmented path:

```text
Browser A (layers 0..7)
  -> two measured boundary tensors
  -> Coordinator relay
  -> Browser B (layers 8..15 + final norm + lm_head)
  -> logits / one continuation token
```

Continuous Assurance production deployment #158 is intentionally held until
this path is demonstrated with real model artifacts and two distinct browser
workers.

## What this change automates

The automated part stops immediately before a real 1.7 GB q4 artifact and a
WebGPU browser are required.

### 1. Deterministic graph split

`tools/split_llama_1b_onnx.py` loads the source ModelProto with
`load_external_data=False`, discovers the two tensors produced by layer 7 and
consumed by layer 8's `input_layernorm`, and extracts two dependency-closed
subgraphs without loading the large external q4 data into Python memory.

The splitter fails closed unless:

- exactly one layer-8 input-layernorm node is found;
- exactly two inputs to that node are produced by layer 7;
- exactly one `logits` graph output exists.

External initializer `location` / `offset` / `length` metadata is retained. By
default the output directory receives symlinks to the original external-data
file(s), avoiding a second 1.7 GB copy. `--external-data-mode copy` is available
when symlinks are unsuitable.

Output:

```text
split/
  segment0.onnx
  segment1.onnx
  split-manifest.json
  model_q4.onnx_data -> ../source/model_q4.onnx_data
```

The manifest records source/segment SHA-256 values, exact boundary tensor names
and producer nodes, external-data inventory, graph inputs/outputs, and the
expected `2 * hiddenSize * 4` float32 boundary bytes per token.

### 2. Same-machine correctness verifier

`tools/verify_split_onnx.py` runs:

```text
full model -> logits
segment 0 -> boundary tensors -> segment 1 -> logits
```

with the exact same token IDs. It compares the complete logits tensor with
configurable `atol` / `rtol` and separately requires the final-position top-1
token ID to match.

The tool deliberately accepts token IDs rather than adding another tokenizer
dependency. Copy the IDs reported by the browser harness into `--input-ids`.
It creates empty KV-cache tensors from ONNX Runtime input metadata and supports
the measured Llama-3.2-1B defaults (`8` KV heads, head size `64`).

### 3. Two-browser Coordinator relay harness

`browser-harness/webgpu-2b-split/serve.mjs` is a local Coordinator and static
server. It never creates a browser-to-browser route.

Open two distinct browser profiles/windows with the same `run` ID:

```text
http://127.0.0.1:8791/?role=segment0&run=trial-1
http://127.0.0.1:8791/?role=segment1&run=trial-1
```

The first browser runs `segment0.onnx` with ONNX Runtime WebGPU, serializes the
two real boundary tensors, and POSTs them to the Coordinator. The second browser
polls the Coordinator, reconstructs those tensors, runs `segment1.onnx`, and
reports the top-1 continuation token.

For worker-loss/resume verification, replace the second URL with a standby after
the checkpoint has been uploaded:

```text
http://127.0.0.1:8791/?role=standby&run=trial-1&worker=browser-b-standby
```

The stored checkpoint remains Coordinator-owned, so the standby can continue
without rerunning segment 0.

## Automated CI gate

The Python test creates a tiny Llama-shaped ONNX fixture with external weights,
splits it, verifies the external-data references survive, and uses ONNX Runtime
to prove that the full-model logits and `segment0 -> segment1` logits are
numerically identical. It also verifies boundary-contract drift fails closed.

The Vitest Coordinator test proves:

- two worker registrations are distinct;
- exactly two boundary tensors are stored and fetched through Coordinator state;
- direct worker-to-worker networking returns HTTP 403;
- a standby worker can consume the already-stored checkpoint and submit a
  resumed result.

Focused commands:

```bash
cd LLM-proto
python3 -m unittest discover -s tools/tests -p 'test_*.py'
npm test -- --run tests/real-two-browser-coordinator.test.ts
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
python3 -m venv .venv-real-split
. .venv-real-split/bin/activate
pip install -r tools/requirements-real-split.txt
```

### A. Split the real q4 graph

```bash
cd LLM-proto
python3 tools/split_llama_1b_onnx.py \
  /absolute/path/to/onnx/model_q4.onnx \
  /absolute/path/to/unzen-split
```

Expected first stop conditions:

- if the real layer-8 graph no longer exposes exactly the measured two-tensor
  boundary, the tool stops and prints the producer/input details;
- if external-data paths are unsafe or unavailable, it stops before producing a
  misleading manifest;
- both output graphs must pass `onnx.checker.check_model()`.

### B. Same-machine full-vs-split logits

First run the segment-0 browser once and copy the `input token ids` line, then:

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

### C. Two distinct browser workers

Serve the split directory:

```bash
MODELS_DIR=/absolute/path/to/unzen-split \
  node browser-harness/webgpu-2b-split/serve.mjs
```

Open segment 0 and segment 1 in two distinct Chrome profiles (or two physical
machines that can reach the Coordinator host), using the same `run` ID. Click
`Execute role` in segment 0, then segment 1.

The segment-1 report must include:

- two distinct worker IDs;
- `relayOwner: "coordinator"`;
- `directWorkerNetworking: false`;
- observed `boundaryBytes`;
- segment 0 and segment 1 execution time;
- logits shape;
- top-1 token ID/text and WebGPU adapter metadata.

### D. Real worker-loss resume

1. Run segment 0 and wait for the Coordinator receipt.
2. Close/kill the intended segment-1 primary before it executes.
3. Open a `role=standby` browser using the same `run` ID.
4. Execute the standby.
5. Confirm the result references the original segment-0 worker/checkpoint and no
   second segment-0 execution occurred.

## Evidence status

Passing CI proves the splitter, numeric split contract on a synthetic ONNX graph,
and Coordinator relay semantics. It does **not** claim that Llama-3.2-1B has
already been split or that two real browsers have executed it.

The first real browser report is `self-reported-runtime`. Promotion to
`captured-and-verified` should reuse the existing `EvidenceEnvelope` only after
artifact capture, digest verification, environment metadata, and an independent
verifier are available.
