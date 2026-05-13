# Checkpoint Transfer Measurement Gate

This milestone turns the metadata-only checkpoint estimate from the WebGPU 30B
feasibility gate into an executable serialization and transfer report.

The harness still does not run a real model. It creates deterministic hidden
state payloads from tensor shape and dtype, serializes them with checkpoint
metadata, simulates Coordinator-mediated transfer timing, and reports whether
the measurement can advance to manual browser/WebGPU validation.

## Harness

`src/checkpoint-transfer-measurement.ts` exposes:

| API | Purpose |
|---|---|
| `createDefaultCheckpointMeasurementManifest()` | Builds the default manifest from `evaluateWebGpu30BFeasibility()` so byte and timing deltas stay comparable with the 30B gate |
| `createCheckpointPayload()` | Generates a deterministic hidden-state checkpoint payload from `[batchSize, sequenceLength, hiddenSize]` and dtype |
| `serializeCheckpointPayload()` | Encodes checkpoint metadata plus hidden states into one binary payload |
| `deserializeCheckpointPayload()` | Restores metadata and hidden states for round-trip validation |
| `measureCheckpointSerializationAndTransfer()` | Reports size, serialization/deserialization duration, transfer estimate, observed duration, throughput, retry count, and failure reason |

The default manifest matches the WebGPU 30B gate's `[1, 512, 6656]` float16
checkpoint tensor. That produces a `6,815,744` byte hidden-state payload and a
`407ms` transfer estimate at `16 MiB/s`.

## Report Fields

`measureCheckpointSerializationAndTransfer()` returns:

| Field | Purpose |
|---|---|
| `payloadBytes` | Hidden-state tensor byte size before envelope/header overhead |
| `serializedBytes` | Total Coordinator payload size after metadata serialization |
| `serializationMs` | Estimated hidden-state serialization duration |
| `deserializationMs` | Estimated restore duration on the receiving worker |
| `transferEstimateMs` | Budget comparison timing using raw checkpoint bytes |
| `observedTransferMs` | Simulated Coordinator transfer duration including retry backoff |
| `observedThroughputBytesPerSecond` | Throughput implied by the observed transfer |
| `retryCount` | Number of retry attempts consumed by the transfer path |
| `failureReason` | Scale-up blocker such as transfer-budget overflow or retry exhaustion |
| `comparison.byteDelta` | Difference from the WebGPU 30B feasibility `checkpointBytes` |
| `comparison.transferMsDelta` | Difference from the WebGPU 30B feasibility `checkpointTransferMs` |

## Focused Test Command

```bash
cd LLM-proto
npm test -- --run tests/checkpoint-transfer-measurement.test.ts
```

The full regression bar remains:

```bash
cd LLM-proto
npm test -- --run
npx tsc -p tsconfig.json --noEmit
```

## Manual Browser/WebGPU Measurement Path

Run this only after the simulated measurement report passes:

1. Use the same `checkpointTensorShape` and dtype from the report.
2. Produce a real hidden-state tensor from the selected runtime candidate.
3. Serialize it with the same envelope shape used by the harness.
4. Transfer only through the Coordinator path; do not add worker-to-worker
   networking to recover transfer time.
5. Compare observed bytes, serialization time, transfer time, throughput, and
   retry count with the harness report.
6. Repeat with a warm model artifact cache and a cold browser session.

## Follow-Up Issue Triggers

Open the next issue before advancing when:

- `payloadBytes` or `serializedBytes` exceeds the WebGPU 30B feasibility
  `checkpointBytes` assumption by a material margin;
- `transferEstimateMs` or `observedTransferMs` exceeds `maxTransferMs`;
- retry exhaustion appears under normal Coordinator load;
- serialization/deserialization time dominates the transfer budget;
- a runtime requires worker-to-worker direct transfer to stay inside the budget.

Those bottlenecks should become separate issues because the fix may require
checkpoint compression, KV cache trimming, tensor chunking, binary envelope
changes, or Coordinator transport changes.
