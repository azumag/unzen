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

## Running the probes

From `LLM-proto/`:

```bash
python tools/probe_llama_1b_endpoint_layout_candidates.py \
  /absolute/path/to/model_q4.onnx

python tools/probe_llama_1b_endpoint_dependency_closure.py \
  /absolute/path/to/model_q4.onnx
```

Both commands ultimately invoke the pinned endpoint chunk-envelope probe. A source graph identity, pinned external-data identity, or tied embedding/logits geometry drift therefore fails before candidate geometry is emitted.

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

CI runs both probes against the same pinned Llama 1B graph used by the existing budget blocker and endpoint-envelope probes.

## Evidence boundary

A passing result proves only that the pinned graph still yields the recorded source-row/byte geometry under the recorded source identity, that the candidate range mappings are internally exact, and that whole-artifact dependency-closure arithmetic is internally consistent.

It does **not** prove:

- that the 4/5/8 candidate payloads have all been materialized and independently verified,
- that multiple physical artifacts are an approved manifest/cache contract,
- that ORT Web can bind the slices without hidden whole-weight reconstruction,
- that physical dependency-closure bytes equal resident host/GPU memory,
- that the physical payload count should be 4, 5, or 8,
- that an 8-way execution plan should be adopted,
- that peak host/GPU working set is acceptable,
- that browser cold/warm latency is acceptable,
- that embedding or logits execution is numerically equivalent,
- that a normal short-lived visitor should run endpoint stages.

Those remain explicit #223 decision and S0 feasibility gates. Runtime, manifest, loader, cache, residency, dispatcher, and artifact-policy behavior remain unchanged by these probes.
