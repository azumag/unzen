# WebGPU 30B Partial Inference Feasibility Gate

This milestone decides whether the prototype can move from simulated 2B
control flow to a 30B-class WebGPU partial-inference experiment.

The CI gate is intentionally metadata-only. It does not download a real 30B
model, compile WebGPU shaders, or run browser hardware tests. Instead,
`src/webgpu-30b-feasibility.ts` verifies that the segment manifest, checkpoint
shape, runtime capabilities, and adaptive dispatcher assumptions are internally
consistent. Manual browser validation remains a separate local gate.

## Target Manifest

| Field | Gate |
|---|---|
| Model class | 28B-34B parameters |
| Quantization | 4-bit or smaller for the first 30B WebGPU attempt |
| Segment count | Contiguous layer ranges declared by the `SegmentedModelManifest` (the 30B example uses 8) |
| Segment size | Each segment must fit the declared worker memory budget |
| Dispatcher fit | Each segment must fit `WorkerTelemetry.vramFreeMB` used by `AdaptiveChunkDispatcher` |
| Checkpoint tensor | `[batchSize, sequenceLength, hiddenSize]` plus dtype |
| Transfer budget | Estimated checkpoint transfer must fit the scale-up gate |
| Runtime candidate | At least one runtime must support WebGPU, layer boundaries, checkpoint resume, and the selected quantization |

The default metadata manifest is:

```ts
createDefault30BFeasibilityManifest()
```

> [!IMPORTANT]
> The model geometry now comes from a `SegmentedModelManifest`
> (see [model-manifest.md](./model-manifest.md), issue #102). The default
> 30B / 8-segment / ~2.1GB values are an **EXAMPLE fixture** for planning, not
> measured fact: the fixture manifest is marked `source: 'fixture'`, its memory
> basis is `budgeted`, and the report carries the manifest's `modelRevision`
> and `manifestDigest` so any run is traceable to a concrete model artifact.

It models an 8-segment 30B-class q4 split, ~2.1GB per segment, a
`[1, 512, 6656]` float16 checkpoint tensor, and dispatcher telemetry that stays
within the 2-3% load budget from `docs/adaptive-chunk-dispatcher.md`.

## Runtime Checks

Runtime candidates are tracked separately because the blocking issue differs by
backend:

| Runtime | Validation focus |
|---|---|
| Transformers.js v4 | WebGPU backend maturity, model export path, whether layer-boundary execution and checkpoint resume can be exposed |
| WebLLM | MLC packaging for partial layer shards, q4 artifact cache behavior, checkpoint tensor handoff |
| ONNX Runtime Web | ONNX graph slicing, WebGPU execution provider limits, external checkpoint resume |

The metadata gate passes only when one runtime candidate can satisfy all four
conditions: WebGPU support, layer-boundary execution, checkpoint resume, and
quantization compatibility. Failed candidates remain useful because their
failure reasons should become the next implementation issue.

## Report Fields

`evaluateWebGpu30BFeasibility()` returns:

| Field | Purpose |
|---|---|
| `modelId` / `modelRevision` / `manifestDigest` | Trace the report to a concrete model manifest (issue #102) |
| `checkpointTensorShape` | Exact checkpoint tensor shape to reproduce in browser tests |
| `checkpointBytes` | Estimated hidden-state transfer size |
| `checkpointTransferMs` | Transfer estimate used by the Scale-Up Gate |
| `segments[].fitsWorkerMemoryBudget` | Manual browser memory-budget check |
| `segments[].fitsDispatcherWorkerTelemetry` | Consistency check against adaptive dispatcher telemetry |
| `runtimes[].failureReasons` | Backend-specific blockers |
| `scaleUpGates[]` | Pass/fail checklist for issue triage |
| `failureReasons[]` | Concise next-issue candidates when the gate fails |

## Focused Test Command

```bash
cd LLM-proto
npm test -- --run tests/webgpu-30b-feasibility.test.ts
```

The full regression bar remains:

```bash
cd LLM-proto
npm test -- --run
npx tsc -p tsconfig.json --noEmit
```

## Manual Browser/WebGPU Checklist

Run this only after the metadata gate passes:

1. Pick the first passing runtime candidate from the report.
2. Export one contiguous layer segment with the manifest layer boundaries.
3. Load only that segment in a browser WebGPU worker.
4. Measure peak adapter memory against `workerMemoryBudgetMB`.
5. Produce a checkpoint tensor matching `checkpointTensorShape`.
6. Transfer the checkpoint through the Coordinator path and compare observed
   transfer timing with `checkpointTransferMs`.
7. Repeat with a warm artifact cache to confirm cold load is not hidden in the
   per-token timing.
8. Record adapter name, browser version, runtime version, peak memory, shader
   compile time, first-token time, and failure mode.

## Advance / Stop Conditions

Advance to real 30B partial inference only when:

- the metadata report status is `pass`;
- a runtime candidate reports no capability failures;
- manual WebGPU memory and checkpoint transfer measurements are inside the
  report budgets;
- the browser worker still obeys the Coordinator/CDN-only networking boundary.

Open a follow-up issue instead of advancing when:

- a segment exceeds either `workerMemoryBudgetMB` or dispatcher
  `workerVramFreeMB`;
- checkpoint transfer exceeds the configured scale-up budget;
- no runtime supports checkpoint resume at layer boundaries;
- q4 artifacts cannot be produced for the chosen runtime;
- browser WebGPU crashes, loses the device, or requires cross-worker direct
  networking to recover.
