# Browser-budgeted real segmented WebGPU P0 (#165)

## Decision

The first real segmented WebGPU proof must optimize for a **normal browser
visitor**, not for the largest model we can technically fit in VRAM.

Artifact policy per browser worker:

| Level | Artifact bytes per browser | Meaning |
|---|---:|---|
| Target | ~200 MiB | design target |
| Preferred | <=256 MiB | P0 must satisfy this |
| Normal | <=512 MiB | acceptable later with measured UX |
| Degraded | <=1 GiB | exceptional / explicit policy only |
| Rejected | >1 GiB | never schedule to a normal browser worker |

The 1 GiB value is a hard ceiling, **not a target**. Download time, persistent
cache pressure, WebGPU upload/compile, peak memory and short visitor sessions
make much smaller shards preferable.

The policy is encoded in `src/browser-segment-artifact-budget.ts` and the P0
preparation tool fails if a generated shard exceeds the preferred 256 MiB
ceiling.

## Current status

The real P0 was first completed on 2026-08-24 at `self-reported-runtime`
evidence level. After the later runtime/provenance hardening through PR #227, the
full procedure was rerun on 2026-09-06 against `main@50e036dd3245bed207502bc448e821922d21bb0d`:

- the pinned source graph/external-data identities were revalidated and fresh
  browser-ready shards were regenerated;
- full and split logits matched exactly for input IDs
  `504,3575,282,4649,314` (`maxAbsDiff=0.0`, top-1 `260`);
- two Chrome 152 processes with separate `--user-data-dir` profile roots ran
  segment 0 and segment 1 on Apple Metal WebGPU;
- the Coordinator accepted distinct HttpOnly profile probes and reported
  `profileIsolationConfirmed=true`;
- both browser artifacts remained in the preferred tier at about 149 MB;
- the Coordinator relayed the real 23,040-byte boundary and direct worker
  networking returned HTTP 403;
- a fresh-profile cold run, same-profile warm-cache run, and standby continuation
  all completed with `status=pass`.

The latest-main rerun closes the remaining runtime handoff in #168 and proves the
P0 architecture strongly enough for #167. It remains `self-reported-runtime`,
not `captured-and-verified` or production-ready evidence. #158 is independently
blocked by the production cold-start design issue #190 and its own external
credentials/approval/evidence requirements.

### Latest-main runtime evidence (2026-09-06)

Environment:

- macOS 26.6.1, Mac mini Apple M4 / 16 GB
- Chrome 152.0.7977.83, two separate headless Chrome profile roots
- browser adapter: `apple` / `metal-3` / `isFallbackAdapter=false`
- ONNX Runtime Web 1.22.0
- source revision: `onnx-community/SmolLM2-135M-ONNX` @
  `0d747f789bcf79b9b57a4be7f3277b64c185f8ef`

Pinned/rebuilt artifacts:

- source graph SHA-256:
  `da1d291b342acafd806b284052053902af82c52121c400789bdf8ab1effdb4c8`
- source external data: `181839104` bytes, SHA-256
  `89625d22026f0ccba8ba6007b18818647a28c4fc39c392101f0408f089e63c21`
- segment 0: `148728011` bytes, preferred tier
- segment 1: `148732576` bytes, preferred tier

Same-machine CPU reference gate:

- logits shapes: `[1,5,49152]` / `[1,5,49152]`
- `maxAbsDiff=0.0`
- full top-1 = split top-1 = `260`
- boundary: 2 x `[1,5,576]` float32 = `23040` bytes

Cold profile-isolated run `latest-main-cold-20260906`:

- result: `status=pass`
- manifest digest:
  `682046e90d042723a872696954cb76d954013de10896b61bce8ff16a0c6eeeb3`
- result digest:
  `24d15c55d8ac2268a79624a42bb02ff6de7d6fd1c5629b92964139ab651469b8`
- segment 0: cache miss, session create `758.1 ms`, execution `201.8 ms`
- segment 1: cache miss, session create `820.4 ms`, execution `368.5 ms`
- top-1: `260` (`" the"`)
- relay owner: `coordinator`; direct worker networking: `false`
- profile isolation method: `coordinator-issued-http-only-cookie`; confirmed
- source/segment-1 profile probe hashes were distinct

Warm run `latest-main-warm-20260906` reused the same two profile roots:

- both segment artifact sets: `allCacheHits=true`
- segment 0: session create `175.2 ms`, execution `67.2 ms`
- segment 1: session create `333.0 ms`, execution `75.0 ms`
- boundary remained `23040` bytes; top-1 remained `260`
- `profileIsolationConfirmed=true`

Standby run `latest-main-standby-20260906`:

- segment 0 stored one Coordinator checkpoint
- no primary segment-1 execution was started for this run
- role `standby` reused that exact checkpoint and completed segment 1
- segment 0 / standby execution: `72.5 ms` / `51.3 ms`
- `relayOwner=coordinator`, `directWorkerNetworking=false`
- top-1 remained `260`, `profileIsolationConfirmed=true`

## P0 model

Use `onnx-community/SmolLM2-135M-ONNX`, q4.

Model/runtime parameters used by this P0:

- architecture: LlamaForCausalLM
- 30 transformer layers
- hidden size: 576
- KV heads: 3
- head size: 64
- split: layers 0..14 / 15..29
- source q4 external weights: about 182 MB before splitting

This model is intentionally chosen for **architecture validation**, not model
quality. The goal is to prove that a real transformer can execute:

```text
Browser A: first half of layers
  -> real boundary tensors
  -> Coordinator-owned relay
Browser B: second half + output head
  -> logits / continuation token
```

After this works, the 1B-class scale-up must increase the segment count rather
than letting browser artifacts grow beyond the same budget.

## What PR #166 automates

### Graph split and per-segment weights

`tools/split_llama_1b_onnx.py` is Llama-shaped despite its historical filename.
It accepts `--split-layer` / `--hidden-size`, discovers the exact layer boundary,
and fails closed when the expected two-tensor residual boundary is absent.

`tools/prepare_real_split.py` extracts dependency-closed graphs and repacks only
the external-data ranges used by each segment into independent weight files.
Browsers therefore do not download the full model blob each.

For this P0, use the stricter wrapper `tools/prepare_browser_p0.py`. It fixes
the SmolLM2 geometry and computes **graph bytes + segment weight bytes** for
every browser shard. Default success requires every segment to be `preferred`
(<=256 MiB). An oversized shard fails with an instruction to increase the
segment count instead of silently weakening the browser policy.

### Same-machine correctness

`tools/verify_split_onnx.py` compares:

```text
full model -> logits
segment 0 -> boundary tensors -> segment 1 -> logits
```

using identical token IDs. It requires complete logits to be within tolerance
and the final-position top-1 token ID to match.

### Two-browser relay

`browser-harness/webgpu-2b-split/serve.mjs` is the localhost Coordinator/static
server. The directory name is historical; the harness is now the generic real
segmented-browser P0 path.

The browser runner:

- uses ONNX Runtime WebGPU;
- loads only the current segment graph/weights;
- verifies graph/weight SHA-256 before use;
- persists verified artifacts in Browser Cache API;
- reports cold/warm artifact and session-creation timing;
- sends the two boundary tensors to the Coordinator;
- never opens a browser-to-browser path;
- allows a standby browser to reuse the existing Coordinator checkpoint.

Use `p0-smollm2.html` as the entrypoint. It unconditionally pins the P0 model ID,
KV-head count, head size, and `artifactBudget=p0`; query-string overrides for
those evidence-defining parameters are ignored. Operator-specific role, run ID,
and split root remain configurable.

## Automated CI gate

CI covers:

- TypeScript browser artifact policy boundaries;
- real external-data ONNX fixture split/repack;
- segment-specific weight files instead of duplicated full-model weights;
- full-vs-split numerical equivalence;
- fail-closed boundary drift;
- P0 artifact budget enforcement;
- Coordinator relay and standby semantics;
- direct worker-to-worker HTTP 403;
- browser/Coordinator syntax checks;
- full existing Vitest regression suite.

## Real verification procedure

The following procedure remains useful for reproducing the P0 or validating a
new model/export. The recorded #168 result has already completed it for the
pinned SmolLM2 revision.

### 1. Download the small P0 source model

Keep model files outside git. With the Hugging Face CLI, for example:

```bash
hf download onnx-community/SmolLM2-135M-ONNX \
  onnx/model_q4.onnx \
  onnx/model_q4.onnx_data \
  --revision 0d747f789bcf79b9b57a4be7f3277b64c185f8ef \
  --local-dir /absolute/path/to/smollm2-135m
```

Expected source layout:

```text
/absolute/path/to/smollm2-135m/
  onnx/model_q4.onnx
  onnx/model_q4.onnx_data
```

### 2. Prepare browser-budgeted shards

```bash
cd LLM-proto
python3 -m venv .venv-real-split
. .venv-real-split/bin/activate
pip install -r tools/requirements-real-split.txt

python3 tools/prepare_browser_p0.py \
  /absolute/path/to/smollm2-135m/onnx/model_q4.onnx \
  /absolute/path/to/smollm2-p0-split
```

`prepare_browser_p0.py` fails closed unless `model_q4.onnx` is exactly the pinned
revision graph (`sha256=da1d291b342acafd806b284052053902af82c52121c400789bdf8ab1effdb4c8`).
The normal P0 path also requires the pinned `model_q4.onnx_data` identity
(`181839104` bytes, `sha256=89625d22026f0ccba8ba6007b18818647a28c4fc39c392101f0408f089e63c21`).
This prevents a different Llama-shaped graph or weight blob from being labeled as P0 evidence.

The manifest must show:

- `modelProfile.modelId = onnx-community/SmolLM2-135M-ONNX`
- `modelProfile.revision = 0d747f789bcf79b9b57a4be7f3277b64c185f8ef`
- `sourceModel.sha256 = da1d291b342acafd806b284052053902af82c52121c400789bdf8ab1effdb4c8`
- `sourceModel.externalData[0].bytes = 181839104`
- `sourceModel.externalData[0].sha256 = 89625d22026f0ccba8ba6007b18818647a28c4fc39c392101f0408f089e63c21`
- `browserArtifactBudget.requiredTier = preferred`
- every `browserArtifactBudget.segments[].tier = preferred`
- every segment `browserArtifactBytes <= 268435456`
- `artifactLayout = per-segment-external-data`

Do not continue if the provenance or budget gate fails. The browser P0 runner
re-validates the same model ID, revision, source graph digest, geometry, boundary
contract, and preferred-budget metadata before loading segment artifacts.

### 3. Start the local Coordinator

```bash
MODELS_DIR=/absolute/path/to/smollm2-p0-split \
  node browser-harness/webgpu-2b-split/serve.mjs
```

### 4. Obtain token IDs

Open:

```text
http://127.0.0.1:8791/p0-smollm2.html?role=segment0&run=smollm2-p0-1
```

Execute segment 0 once and copy the `input token ids:` line.

### 5. Same-machine full-vs-split correctness

```bash
python3 tools/verify_split_onnx.py \
  --full-model /absolute/path/to/smollm2-135m/onnx/model_q4.onnx \
  --segment0 /absolute/path/to/smollm2-p0-split/segment0.onnx \
  --segment1 /absolute/path/to/smollm2-p0-split/segment1.onnx \
  --manifest /absolute/path/to/smollm2-p0-split/split-manifest.json \
  --input-ids '...copied ids...' \
  --kv-heads 3 \
  --head-size 64
```

This is the first real-model stop/go gate. Do not call the architecture proven
unless this succeeds.

### 6. Real two-browser WebGPU execution

Use two distinct Chrome profiles/windows with the same run ID:

```text
http://127.0.0.1:8791/p0-smollm2.html?role=segment0&run=smollm2-p0-2
http://127.0.0.1:8791/p0-smollm2.html?role=segment1&run=smollm2-p0-2
```

Execute segment 0, then segment 1. The result must show distinct worker IDs,
Coordinator-owned relay, no direct worker networking, observed boundary bytes,
WebGPU adapter data, per-segment execution timing and artifact cache timing.

### 7. Cold/warm measurement

Use the harness cache-clear control before the cold run. Repeat the same worker
role without clearing cache for the warm run. Record artifact fetch/cache and
session creation timing separately.

### 8. Worker-loss resume

After segment 0 has stored the checkpoint, do not execute (or close) the primary
segment-1 browser. Start:

```text
http://127.0.0.1:8791/p0-smollm2.html?role=standby&run=smollm2-p0-3&worker=browser-b-standby
```

The standby must finish from the already stored checkpoint without a second
segment-0 execution.

## Scale-up after P0

The next 1B-class milestone must be **artifact-budget driven**:

```text
1B q4 model
  -> choose enough contiguous layer segments
  -> target ~200 MiB per browser
  -> preferred <=256 MiB
  -> never >1 GiB
```

A long-lived high-capacity worker may be assigned several adjacent segments via
SpanPipeline, but those remain separate cached artifacts. This preserves the
small-download browser unit while allowing stable workers to reduce checkpoint
relay overhead.

### Budget-driven planner tooling

`tools/multi_segment_onnx.py` prepares the #167 1B scale-up. It:

- builds one exact graph contract used by both estimation and generation;
- counts deduplicated `(location, offset, length)` external-data ranges, matching
  the segment repacker;
- rejects absolute/traversal locations, negative/non-integer ranges and ranges
  that exceed their source file;
- solves the contiguous minimax partition with polynomial-time dynamic
  programming rather than enumerating every cut combination;
- selects the fewest segments, then the smallest maximum shard, then the plan
  closest to `--target-bytes`;
- never allows `--preferred-max-bytes` to relax the product 256 MiB ceiling;
- rechecks the requested ceiling and the fixed product tier against actual
  generated graph + weight bytes.

```bash
python tools/multi_segment_onnx.py \
  /absolute/path/to/Llama-3.2-1B-Instruct/onnx/model_q4.onnx \
  /absolute/path/to/llama-1b-budget-split
```

The generated `split-manifest.json` records the target and required maximum,
cut layers, estimated bytes, actual maximum generated bytes, boundary tensors,
artifact hashes and fixed browser-budget verdicts.

This planner is preparation-only evidence. #167 still requires a real 1B q4
artifact run, full-vs-multi-segment numerical equivalence, multi-browser
Coordinator relay, cold/warm cache measurements and WebGPU execution evidence.
