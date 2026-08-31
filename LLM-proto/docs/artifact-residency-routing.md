# Artifact residency and span routing

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

## Invariants

- A ledger is model-revision local. Equal segment indexes from different model
  revisions must never share one ledger.
- Segment indexes are contiguous `0..n-1`.
- Artifact byte sizes are safe positive integers and represent the complete
  browser bundle for that segment, including external weights.
- Runtime `SegmentConfig` digest, layer range and memory estimate must match the
  artifact inventory before dispatch begins.
- Unknown cache indexes reject the whole heartbeat update atomically.
- Browser workers connect only to the Coordinator and allowlisted artifact
  origin; the routing changes do not introduce browser-to-browser networking.

## Evidence level and remaining work

The current implementation is `contract-tested`. It proves inventory and
routing behavior with deterministic fixtures, not a completed 1B browser run.
Issue #167 still requires:

- generating the real 1B q4 artifacts and recording actual bytes;
- full-model versus multi-segment numerical equivalence;
- multi-browser WebGPU execution through the Coordinator;
- measured cold/warm cache and checkpoint overhead;
- retry from the nearest durable checkpoint rather than restarting the route;
- captured runtime evidence with no direct worker-to-worker path.
