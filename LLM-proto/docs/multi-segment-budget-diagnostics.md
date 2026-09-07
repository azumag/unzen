# Multi-segment browser budget diagnostics

Before generating multi-gigabyte shards, inspect whether the current graph contract can satisfy the browser artifact tiers:

```bash
python tools/diagnose_multi_segment_budget.py \
  /absolute/path/to/model_q4.onnx \
  --hidden-size 2048
```

The diagnostic loads only the ONNX graph metadata and external-data ranges. It does not run ONNX Runtime, generate shards, or claim numerical/browser evidence.

It reports:

- feasibility under preferred (256 MiB), normal (512 MiB), and absolute (1 GiB) ceilings;
- the planner's exact minimum achievable maximum and machine-readable oversized singleton spans when a tier is infeasible;
- every single-layer span estimate;
- the worst single-layer spans and their largest retained external initializers.

Use this report to distinguish "add more decoder cuts" from a graph-decomposition blocker where even the smallest legal span is too large.

## Real Llama-3.2-1B q4 observation

Issue #223 records the first real #167 run against `onnx-community/Llama-3.2-1B-Instruct` revision `14007543b6dc92de88daf96a9aa85d2f95ace6ef`.

The current decoder-layer-only graph contract is infeasible even at the 1 GiB hard ceiling:

- layer 0 alone: about 1070.28 MiB;
- layers 1 through 14 alone: about 68.28 MiB each;
- layer 15 alone: about 1070.29 MiB.

Both edge spans retain the tied `model.embed_tokens.weight` initializer, which is 1002 MiB by itself. Adding rotary caches and one decoder layer pushes the edge artifacts above 1 GiB.

This is not a reason to relax the hard browser policy. It is evidence that the graph needs a different decomposition (for example prefix/postfix edge stages or vocabulary-axis chunking). That runtime/manifest design is tracked separately in #223.

When a tier is infeasible, `multi_segment_onnx.py` preserves the human-readable fail-close error while also exposing the same budget floor and oversized singleton spans through `BrowserArtifactBudgetError.as_dict()`. The diagnostic command emits those fields directly as JSON, so automation does not need to parse error text.

For the pinned real 1B artifact, the command currently reports `minimumAchievableMaximumBytes=1122275890` for all three policy tiers, with `[0,1)=1122266530` and `[15,16)=1122275890` as the oversized singleton spans. The largest retained initializer on both spans is `model.embed_tokens.weight` at `1050673152` bytes.

## CI regression probe

`LLM Proto` CI downloads only the pinned 149 KiB ONNX graph (not the 1.7 GB external weight file) and runs `probe_llama_1b_budget_blocker.py`. Because the graph contains the external-data ranges, the probe can reproduce the exact layer-span estimates and reject drift in the source graph digest, 16-layer contract, hard-policy infeasibility, endpoint singleton sizes, or tied-embedding byte count without paying the bandwidth/storage cost of the full weights.

## Endpoint-isolation candidate estimate

The same graph-only diagnostic now reports `endpointIsolationCandidates` when it can identify a pre-decoder embedding activation and the final decoder-to-logits boundary. This is deliberately **diagnostic-only**: it does not change the split manifest, browser runtime, dispatcher, or the policy ceilings.

For the pinned real Llama-3.2-1B q4 graph, the two edge-only dependency closures are estimated as:

- `embedding-prefix`: `1,050,673,652` bytes total (`1,050,673,152` external bytes);
- `logits-postfix`: `1,050,682,706` bytes total (`1,050,681,344` external bytes).

Both are above the 256 MiB preferred and 512 MiB normal tiers, but below the 1 GiB hard ceiling. The estimate therefore narrows #223: endpoint isolation can remove the current hard-ceiling violation without relaxing the hard policy, but it would still require an explicitly exceptional edge-stage contract if selected. No such runtime/manifest decision is made by this diagnostic.

The diagnostic also reports `estimatedTierMarginBytes` (tier limit minus estimated artifact bytes) and `smallestPassingTier` for each candidate. For the pinned graph, `embedding-prefix` has 23,068,172 bytes of estimated hard-ceiling headroom and `logits-postfix` has 23,059,118 bytes; both report `smallestPassingTier: absolute`. Negative preferred/normal margins make the exceptional nature explicit without changing any policy threshold. These are graph-only estimates, not a substitute for materialized artifact measurements.

Each candidate also includes `externalDataLayout`, which deduplicates the exact `(location, offset, length)` ranges already present in the source graph. This does not propose a cache format; it answers whether the existing external-data range boundaries are already small enough for each tier. On the pinned graph, `embedding-prefix` has one external range and `logits-postfix` has two, but both are dominated by the same `model.embed_tokens.weight` range at `1,050,673,152` bytes. That single existing range exceeds both the 256 MiB preferred and 512 MiB normal tiers while remaining below 1 GiB. Therefore merely preserving or regrouping the upstream external-data ranges cannot produce preferred/normal cache units; doing so would require splitting inside that initializer range or choosing a different artifact. The diagnostic records this constraint without selecting either design.

The layout now also reports `firstAxisPayloadChunkLowerBound` for the largest external range when its first axis can be interpreted as fixed-size contiguous rows. This remains diagnostic-only and deliberately excludes graph, manifest, loader, and runtime overhead. For the pinned tied embedding `[128256, 2048]`, each vocabulary row occupies 8,192 bytes. A row-aligned payload therefore needs at least 4 pieces for the 256 MiB tier, 2 for 512 MiB, and 1 for 1 GiB. Balancing the minimum four preferred-tier pieces gives a largest raw payload of 262,668,288 bytes (250.5 MiB), leaving 5,767,168 bytes below the tier limit before any per-artifact overhead. This quantifies the lower bound for a vocabulary-axis/cache-artifact design without selecting that design or asserting that four complete browser artifacts will fit.

`probe_llama_1b_budget_blocker.py` pins these graph-only candidate sizes and their estimated tier classification in CI. If upstream graph structure changes so the endpoint closure is no longer discoverable, or either candidate crosses the 1 GiB ceiling, the probe fails rather than silently treating the old observation as current.

## Co-located source-stage residual envelope

`probe_llama_1b_endpoint_chunk_envelope.py` tightens the payload-only lower bound without selecting a runtime or cache format. It assumes the entire current serialized endpoint subgraph plus every existing external-data range other than the 1002 MiB tied embedding are conservatively co-located with the largest balanced embedding payload. It then recomputes the minimum row-aligned payload count for each policy tier. New packaging, manifest, loader, cache, and runtime metadata remain excluded and must fit inside the reported headroom if this design is ever selected.

For the pinned graph, the existing non-chunked source-stage residual is only 500 bytes for `embedding-prefix` and 9,554 bytes for `logits-postfix`. Those residuals do **not** increase the minimum counts: preferred remains 4 payloads, normal remains 2, and absolute remains 1. Under the conservative co-location assumption, the preferred-tier maximum artifact estimates are 262,668,788 bytes for `embedding-prefix` and 262,677,842 bytes for `logits-postfix`, leaving 5,766,668 bytes and 5,757,614 bytes of headroom respectively.

This is stronger evidence than the raw payload lower bound because it accounts for every byte already present in the graph-only endpoint closure, while still stopping short of an artifact/runtime decision. The remaining roughly 5.75 MiB preferred-tier headroom is the budget available to any yet-unimplemented chunk packaging metadata and loader/cache representation; a future materialized design must measure those bytes rather than assume they are free.

The probe also emits `balancedSourcePayloadChunks`: a deterministic **source-byte blueprint** for the minimum balanced row split at each tier. This still does not create artifacts or define a runtime contract; it only fixes which bytes of the pinned upstream initializer would belong to each candidate payload if vocabulary-row chunking were later selected. For the preferred tier, the pinned `[128256, 2048]` embedding divides evenly into four 32,064-row payloads of 262,668,288 bytes each. Their source offsets in `model_q4.onnx_data` are `0`, `262668288`, `525336576`, and `788004864`, ending exactly at byte `1050673152`. CI rejects drift in the source location, offset, row geometry, or these contiguous byte ranges, so a future materializer can consume a stable diagnostic blueprint rather than rediscovering chunk boundaries.

## Diagnostic source-payload materialization

`materialize_endpoint_payload_chunks.py` can now turn one of those blueprints into exact raw byte slices when the pinned external-data file is available locally. This closes the gap between graph-only range arithmetic and an actual byte-for-byte materialization experiment without deciding that the slices are browser artifacts or execution stages.

```bash
python tools/probe_llama_1b_endpoint_chunk_envelope.py \
  /absolute/path/to/model_q4.onnx \
  > /tmp/endpoint-chunk-envelope.json

python tools/materialize_endpoint_payload_chunks.py \
  /absolute/path/to/model_q4.onnx_data \
  /tmp/endpoint-chunk-envelope.json \
  /tmp/unzen-endpoint-payloads \
  --stage embedding-prefix \
  --tier preferred \
  --report-out /tmp/unzen-endpoint-payload-materialization.json
```

The probe report also carries the pinned external-data identity (`model_q4.onnx_data`, 1,692,672,000 bytes, SHA-256 `07cc629ef2cb7fdb18615ce2e4f3774f763e6fc840207d772a8b511eead36647`). Before writing any payload, the CLI requires the blueprint location to match that identity, verifies the local source byte size, and streams the complete source once to verify its SHA-256. This prevents a different file with the same basename from being presented as materialization evidence for the pinned model.

The materializer also validates that row coverage and source byte ranges are contiguous, rejects unsafe source locations and truncated source files, refuses to overwrite existing payloads or reports, streams each output range with bounded memory, and records the actual byte count and SHA-256 of every emitted slice. Any partial files created by the current run are removed if materialization fails without deleting pre-existing files. Unit tests use a tiny synthetic external-data file; CI still does not download the 1.7 GB pinned weight file, so the real full-file identity check remains a local evidence step when that file is already available.

Materialization report schema `1.1.0` also binds the emitted bytes to the exact diagnostic selection that produced them. The `provenance` object records the probe kind/schema, pinned source-graph SHA-256, `stageKind`, policy `tier`, pinned external-data identity, and a SHA-256 of the canonical selected source-byte blueprint. This matters because `embedding-prefix` and `logits-postfix` both reference the same tied embedding range and can therefore produce identical raw payload slices at the same tier; payload hashes alone cannot identify which endpoint candidate was selected. The CLI regenerates and revalidates the pinned blueprint before constructing this provenance, and refuses a caller-supplied chunk list that differs from that selected blueprint.

The emitted `unzen-endpoint-source-payload-materialization` report is explicitly `decisionStatus=diagnostic-only`. The payload filenames and report are measurement scaffolding only. They do not establish a browser cache format, manifest schema, loader behavior, endpoint execution semantics, or approval of vocabulary-axis chunking. Those remain the explicit design decision in #223.

## Independent materialization verification

`verify_endpoint_payload_materialization.py` verifies the producer evidence as a separate pass. It requires the expected `--stage` and `--tier` on the command line instead of trusting those fields from the materialization report, independently derives the pinned blueprint/provenance from the probe report, checks the source identity and coverage metadata, requires the payload directory to contain exactly the expected `payload-*.bin` set, rejects symlink payloads, and re-hashes every payload before returning `status=pass`.

```bash
python tools/verify_endpoint_payload_materialization.py \
  /tmp/endpoint-chunk-envelope.json \
  /tmp/unzen-endpoint-payload-materialization.json \
  /tmp/unzen-endpoint-payloads \
  --stage embedding-prefix \
  --tier preferred \
  --report-out /tmp/unzen-endpoint-payload-verification.json
```

The verifier hashes the exact UTF-8 JSON bytes it parses for both input reports and includes those digests in `inputReports`, so a verification result can be tied back to the precise probe/materialization documents. Its own report is also `decisionStatus=diagnostic-only`: independent byte verification strengthens the evidence chain but does not select vocabulary-axis chunking or change browser cache, manifest, loader, runtime, dispatcher, or artifact-policy semantics.
