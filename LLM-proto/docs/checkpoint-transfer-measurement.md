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
| `serializeCheckpointPayload()` | Validates and encodes checkpoint metadata plus hidden states into one binary payload |
| `deserializeCheckpointPayload()` | Validates and restores metadata and hidden states for round-trip validation |
| `measureCheckpointSerializationAndTransfer()` | Reports size, serialization/deserialization duration, transfer estimate, observed duration, throughput, retry count, and failure reason |

The default manifest matches the WebGPU 30B gate's `[1, 512, 6656]` float16
checkpoint tensor. That produces a `6,815,744` byte hidden-state payload and a
`407ms` transfer estimate at `16 MiB/s`.

When a caller supplies a feasibility report explicitly to
`createDefaultCheckpointMeasurementManifest()`, the helper first snapshots the
consumed report values instead of validating and then re-reading caller-owned
properties. `checkpointTensorShape` is captured once, each of its three
dimensions is captured once, and `checkpointBytes` / `checkpointTransferMs` are
captured once in fail-fast order. The returned default manifest is built only
from those validated owned values, so getter/Proxy-backed reports cannot swap in
unchecked geometry or comparison values after validation. The report must be a
non-null, non-array object; `checkpointTensorShape` must contain exactly three
positive safe integers; `checkpointBytes` must be a positive safe integer; and
`checkpointTransferMs` must be a non-negative safe integer. Omitting the
argument keeps the existing default path through the validated feasibility
evaluator.

## Runtime Input Contract

The measurement harness treats its manifest and serialized checkpoint frame as
runtime trust boundaries. Invalid values are rejected before allocation or
timing arithmetic rather than being allowed to become `NaN`, `Infinity`, a
wrapped precision value, or a misleading measurement.

Before any manifest field is read, the public measurement and payload-generation
paths require a non-null, non-array object. Asserted or decoded values such as
`null`, primitives, arrays, symbols, or binary views therefore fail with the
measurement-manifest contract error rather than an incidental JavaScript field
access failure.

The consumed measurement inputs are snapshotted before allocation or analysis.
Each caller-owned top-level field is read once in fail-fast order; the tensor
reference is captured once and its `batchSize`, `sequenceLength`, `hiddenSize`,
and `dtype` fields are each read once into a plain owned tensor snapshot. The
same captured tensor geometry drives validation, payload-byte calculation,
`Uint8Array` allocation, generated metadata, and report shape. Throughput,
budget, retry, and optional expected-value controls are likewise captured once
and the owned values alone drive timing, retry simulation, feasibility deltas,
and report identity. The harness does not enumerate the caller manifest, so a
Proxy `ownKeys` trap or unrelated enumerable getter is not part of the runtime
contract. This prevents getter/Proxy values from passing validation and then
drifting before allocation or report construction.

Manifest requirements:

- the top-level manifest is a non-null, non-array object;
- `requestId` is a non-empty string.
- `segmentIndex` is a non-negative JavaScript safe integer.
- tensor dimensions are positive JavaScript safe integers and `dtype` is one of
  `float16`, `float32`, or `int8`.
- tensor element/byte multiplication must remain within
  `Number.MAX_SAFE_INTEGER` before `Uint8Array` allocation is attempted.
- serialization/deserialization/Coordinator throughput and `maxTransferMs` are
  positive finite numbers.
- retry counts/backoff and simulated failure counts are non-negative JavaScript
  safe integers.
- optional expected byte counts are positive safe integers; optional expected
  transfer time is finite and non-negative.

Derived timing arithmetic is also bounded. Duration estimates must resolve to
non-negative JavaScript safe integers, and Coordinator attempt counts, repeated
transfer durations, retry-backoff totals, and their final sum use checked
addition/multiplication. A syntactically valid manifest therefore cannot produce
an `Infinity` or precision-lost timing report merely through extreme but valid
numeric inputs.

Checkpoint envelope validation is symmetric at the relay boundary. Before
serialization, the outbound checkpoint must have a non-empty request ID, a
non-negative safe segment index, genuine `Uint8Array` hidden states, valid tensor
metadata, and a hidden-state byte length that exactly matches the declared
shape/dtype. The serializer captures caller-owned `hiddenStates`, `requestId`,
`segmentIndex`, and `metadata` once in fail-fast order. For the byte payload it
first verifies a real TypedArray view, then reads `buffer`, `byteOffset`, and
`byteLength` through intrinsic TypedArray accessors and constructs a base
`Uint8Array` view. Proxy-wrapped typed arrays therefore fail with the stable
checkpoint validation error, while genuine subclasses cannot spoof byte length
or run caller-defined `buffer`, `byteOffset`, `byteLength`, `slice`, iterator, or
species hooks during frame sizing or copy. The serializer writes only the
validated canonical header fields and checks frame-length arithmetic before
allocation.

The deserializer applies the same byte-view rule before any frame size, buffer,
slice, or decode access. It requires a genuine `Uint8Array` view, captures the
actual `buffer`, `byteOffset`, and `byteLength` through the intrinsic TypedArray
accessors, and continues from a base `Uint8Array` view. Proxy-wrapped frames fail
closed with `serialized checkpoint must be a Uint8Array`; genuine subclasses are
accepted without invoking caller-defined byte-view or copy hooks. The decoded
header then receives the same metadata validation and the actual payload byte
length is independently checked against shape and dtype.

Serialized checkpoint requirements:

- the top-level frame is a genuine `Uint8Array` view; Proxy wrappers are rejected
  before byte access;
- frame `buffer`, `byteOffset`, and `byteLength` come from intrinsic TypedArray
  accessors rather than caller-defined properties;
- the frame contains the four-byte little-endian header-length prefix;
- the declared header length is non-zero and contained by the frame;
- the header is valid JSON with a non-empty request ID, non-negative safe
  segment index, and checkpoint metadata object;
- metadata has exactly three positive safe tensor dimensions, a supported
  dtype, a `sequenceLength` equal to `shape[1]`, and a non-negative safe integer
  timestamp;
- actual payload bytes exactly match the byte count implied by shape and dtype.

These checks are measurement-contract hardening only. They do not authenticate
the evidence producer or prove a real browser/WebGPU/Coordinator transport.

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
npm test -- --run tests/checkpoint-transfer-measurement.test.ts tests/checkpoint-transfer-owned-snapshot.test.ts tests/checkpoint-transfer-byte-view.test.ts
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
