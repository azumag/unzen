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
  "layerEnd": 11,
  "quantization": "q4",
  "sha256": "..."
}
```

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

## Relationship To Existing Designs

- `PLAN.md` remains the reviewed long-term pipeline plan for 30B-class models.
- `SWARM.md` remains a complementary light-model ensemble design; it is not the
  execution path for this two-worker split milestone.
- Existing TypeScript modules under `src/` model the Coordinator, WorkerPool,
  checkpoint, and span-routing concepts. This spec narrows the first runnable
  milestone to two fixed segments before adaptive routing is introduced.
