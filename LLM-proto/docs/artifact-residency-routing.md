# Artifact residency, span routing and checkpoint resume

## Purpose

The 1B-class segmented WebGPU path uses small browser artifacts rather than one
large model download. Routing therefore needs two different sources of truth:

- `SegmentedModelManifest.segments` owns immutable artifact identity, layer
  geometry, measured graph-plus-external-data bytes, locator and memory estimate.
- `ArtifactResidencyLedger` owns mutable worker cache observations for exactly
  one validated model revision.

A heartbeat cache list is an authoritative snapshot. If a browser no longer
advertises a segment, the Coordinator removes that residency claim instead of
retaining a stale cache hit indefinitely.

## Generated ONNX bundle import

`tools/multi_segment_onnx.py` writes one ONNX graph and zero or more external-data
files for each logical browser segment. `importGeneratedOnnxSplitManifest()`
converts that measured output into the runtime manifest without flattening the
files into an unverifiable synthetic artifact.

For each segment it:

1. requires the generated schema, kind, per-segment-external-data layout and
   browser-budget evidence;
2. independently enforces the runtime preferred 256 MiB and absolute 1 GiB
   product ceilings, so generated metadata can tighten but never relax policy;
3. derives graph bytes from measured total bytes minus measured external-data
   bytes and rejects a non-positive remainder;
4. preserves the graph and external-data path, exact byte size and file SHA-256
   as `SegmentArtifact.components`;
5. computes a canonical bundle digest over component content descriptors;
6. converts exclusive generated layer ranges to inclusive runtime ranges and
   validates complete contiguous coverage;
7. derives each artifact locator from one HTTP(S) directory URL, requiring HTTPS
   and credential-free URLs for production;
8. computes and fully validates the final runtime manifest digest.

The bundle digest deliberately excludes deployment URLs so identical bytes keep
the same `modelWeightHash` when moved between origins. The outer model manifest
digest includes all locators and therefore still detects deployment-route
tampering.

## Dispatch flow

```text
generated ONNX graph + external-data manifest
  -> fully validated runtime model manifest
  -> SegmentConfig geometry
  -> ArtifactResidencyLedger
  -> browser heartbeat cache snapshot
  -> AdaptiveChunkDispatcher / SpanRouter
  -> SpanPipeline assignment
  -> validated durable checkpoint
  -> suffix-only reroute after failure
```

The adaptive dispatcher:

1. validates that runtime segment hashes, ranges and memory estimates match the
   ledger inventory;
2. computes capacity by summing each real segment memory estimate, so unequal
   first/last shards remain safe;
3. scores cache locality using exact resident bytes rather than only segment
   count;
4. validates and requests every missing graph/external-data component before it
   commits the logical segment as resident;
5. reports exact total, already-resident and downloaded artifact bytes.

`SpanRouter` gives priority to a contiguous resident prefix at the current
boundary. This lets `SpanPipeline` execute adjacent cached artifacts on one
worker without inserting a Coordinator checkpoint between every segment.
Successful spans are committed to the residency ledger. A disconnected worker's
cache claim is cleared until a later authoritative heartbeat advertises it
again.

## Nearest-checkpoint resume

A non-final span is not considered complete until its result contains a
checkpoint bound to all of the following:

- the active inference request;
- the assigned worker and exact span range;
- the span's final segment index.

Only a result that passes those checks reaches `CheckpointStore`. If a later
browser fails, `SpanPipeline` retains the highest validated non-final checkpoint,
asks `SpanRouter` to cover only the suffix beginning at the next segment, and
passes that checkpoint to the replacement worker. Completed prefix spans are not
re-executed. The same path also resumes from a pre-existing durable checkpoint on
the first attempt.

Final spans must produce output and must not produce another checkpoint. This
prevents a stale or malicious final-boundary checkpoint from skipping the only
span that can return the inference result. Checkpoints are deleted after final
success or terminal failure, but not between retry attempts.

## Invariants

- A ledger is model-revision local. Equal segment indexes from different model
  revisions must never share one ledger.
- Segment indexes are contiguous `0..n-1`.
- Artifact byte sizes are safe positive integers and represent the complete
  browser bundle for that segment, including external weights.
- Bundle component bytes must sum exactly to the logical artifact byte size;
  exactly one component is the ONNX graph and its locator is the primary locator.
- Runtime `SegmentConfig` digest, layer range and memory estimate must match the
  artifact inventory before dispatch begins.
- Unknown cache indexes reject the whole heartbeat update atomically.
- A logical segment becomes resident only after all of its component locators
  pass the transport allowlist.
- A durable checkpoint must match the request and exact completed span boundary.
- A resumed route begins at `checkpoint.segmentIndex + 1` and never includes an
  already completed prefix segment.
- Browser workers connect only to the Coordinator and allowlisted artifact
  origin; the routing changes do not introduce browser-to-browser networking.

## Evidence level and remaining work

The current implementation is `contract-tested`. It proves generated-manifest
import, inventory, routing and suffix-resume behavior with deterministic
fixtures, not a completed 1B browser run. Issue #167 still requires:

- generating the real 1B q4 artifacts and recording actual bytes and memory;
- full-model versus multi-segment numerical equivalence;
- multi-browser WebGPU execution through the Coordinator;
- measured cold/warm cache and checkpoint overhead;
- captured runtime evidence with no direct worker-to-worker path.
