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

## Dispatch flow

```text
validated model manifest
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
4. requests only missing manifest locators from the artifact origin;
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
- Runtime `SegmentConfig` digest, layer range and memory estimate must match the
  artifact inventory before dispatch begins.
- Unknown cache indexes reject the whole heartbeat update atomically.
- A durable checkpoint must match the request and exact completed span boundary.
- A resumed route begins at `checkpoint.segmentIndex + 1` and never includes an
  already completed prefix segment.
- Browser workers connect only to the Coordinator and allowlisted artifact
  origin; the routing changes do not introduce browser-to-browser networking.

## Evidence level and remaining work

The current implementation is `contract-tested`. It proves inventory, routing
and suffix-resume behavior with deterministic fixtures, not a completed 1B
browser run. Issue #167 still requires:

- generating the real 1B q4 artifacts and recording actual bytes;
- full-model versus multi-segment numerical equivalence;
- importing the generated multi-file segment bundles into the runtime manifest;
- multi-browser WebGPU execution through the Coordinator;
- measured cold/warm cache and checkpoint overhead;
- captured runtime evidence with no direct worker-to-worker path.
