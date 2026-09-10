# 8-physical endpoint embedding WebGPU cancellation RSS diagnostic

## Purpose

`tools/capture_endpoint_embedding_eight_physical_webgpu_cancel_rss.mjs` measures the host OS RSS envelope when the isolated 8-physical endpoint-embedding WebGPU diagnostic is cancelled by tearing down its page during a selected tile execution phase.

This is a follow-up to the normal-completion RSS capture from #328 / PR #329. The normal capture waits until all eight `InferenceSession.release()` calls have completed. This cancellation capture intentionally does not wait for a passing runtime report: it observes a configured `executing embedding tile N` phase and immediately navigates the measured page to `about:blank`.

The result is diagnostic-only evidence for #167. It does not select the 8-physical architecture.

## Preconditions

Use the same preflight-approved real 8-physical bundle required by the isolated browser harness:

- the generated payload directory containing all eight physical payloads,
- the actual-file preflight report,
- the pinned `embedding-offset-0.onnx` graph,
- a WebGPU-capable Chrome build.

The harness server remains responsible for validating the preflight snapshot and serving only the approved graph/payload paths.

## Recommended provenance-bound run

For new #167 evidence, prefer the provenance-bound wrapper so the saved cancellation envelope can later be associated mechanically with the exact validated preflight snapshot supplied to the harness invocation:

```bash
node tools/capture_endpoint_embedding_eight_physical_webgpu_cancel_rss_bound.mjs \
  /path/to/eight-physical-data \
  /path/to/preflight.json \
  /path/to/embedding-offset-0.onnx \
  /path/to/cancel-rss.json \
  3 \
  /path/to/cancel-rss-bound.json
```

The wrapper freezes the validated preflight into a private temporary snapshot, passes that snapshot to the existing capture, rechecks its canonical digest after the run, validates the raw cancellation envelope, and writes a separate provenance sidecar. It does not independently re-hash the full payload set and does not claim that tiles after the cancellation target were loaded by the browser. See `docs/endpoint-embedding-eight-physical-cancel-rss-preflight-binding.md` for the exact boundary.

## Raw capture

The lower-level capture remains available when only the RSS envelope is required:

```bash
node tools/capture_endpoint_embedding_eight_physical_webgpu_cancel_rss.mjs \
  /path/to/eight-physical-data \
  /path/to/preflight.json \
  /path/to/embedding-offset-0.onnx \
  /path/to/cancel-rss.json \
  3
```

The final positional argument is the tile whose exact phase must be observed. Valid values are `0` through `7`.

Optional environment variables:

```text
CHROME_BINARY
UNZEN_HARNESS_PORT                 default 8798
UNZEN_CDP_PORT                     default 9338
UNZEN_RSS_SAMPLE_INTERVAL_MS       default 100
UNZEN_RSS_POST_CANCEL_SETTLE_MS    default 30000; 0 is allowed
UNZEN_RSS_TIMEOUT_MS               default 180000
```

All numeric settings are validated as safe integers before Chrome or the harness is started. The harness and CDP ports must be distinct.

## Cancellation boundary

The capture only triggers when the browser reports the exact phase:

```text
executing embedding tile N
```

The runner sets that phase immediately before entering the asynchronous tile routine. Therefore the observation guarantees that the selected tile boundary was reached, but it does **not** prove whether the subsequent page teardown happened during `InferenceSession.create()`, `session.run()`, or another point inside that routine.

Cancellation itself is performed with CDP `Page.navigate` to `about:blank`. This deliberately exercises document teardown as the cancellation mechanism. It is not an ORT/WebGPU in-flight cancellation API.

The capture fails closed instead of emitting cancellation evidence when:

- the harness reports `status=fail`,
- the harness reaches `status=pass` before the configured phase is captured,
- sampling observes a later payload/tile phase, showing that the requested phase was missed,
- the target tile is outside `0..7`,
- Chrome or the harness exits unexpectedly,
- the capture times out,
- a port or timing setting is malformed.

This prevents a fast successful run or missed sampling window from being mislabeled as cancellation evidence.

## Evidence fields

The raw output JSON records:

- the exact configured and observed cancellation phase,
- the coarse cancellation method and navigation-to-blank latency,
- fresh Chrome / OS / Node identity,
- RSS baseline from the initial `about:blank` page,
- process-tree global peak,
- phase-specific peaks observed before cancellation,
- the sample immediately before cancellation,
- the sample immediately after the blank page is ready,
- post-cancel peak, minimum, final RSS, and the first sample at or below baseline when observed.

RSS is summed across only the launched Chrome root process and descendants discovered through PPID relationships. Existing unrelated Chrome processes are not included because the diagnostic starts a fresh Chrome profile and tracks the newly launched root PID.

## Offline verification

Before promoting a persisted raw capture as #167 diagnostic evidence, revalidate it without launching Chrome or WebGPU:

```bash
node tools/verify_endpoint_embedding_eight_physical_webgpu_cancel_rss.mjs \
  /path/to/cancel-rss.json
```

The verifier checks the cancellation/measurement contract and RSS summary relationships, then reads the input through a bounded stable regular-file snapshot. See `docs/endpoint-embedding-eight-physical-webgpu-cancel-rss-verification.md` for the complete fail-close contract and input-integrity boundary.

## Interpretation limits

This evidence is intentionally narrower than a production or architecture decision:

- RSS is an OS process metric, not a direct WebGPU or driver-allocation metric.
- Summed process RSS can double-count shared pages or shared-memory mappings.
- On unified-memory systems RSS cannot distinguish CPU-resident pages from GPU-visible shared allocations.
- The configured sampling interval can miss shorter peaks.
- Chrome may retain renderer processes, driver caches, allocator pages, or shared mappings after the document is destroyed.
- Reaching or dropping below the initial RSS baseline is useful observational evidence, not proof of exact GPU allocator reclamation.
- The provenance-bound wrapper binds to a validated preflight snapshot; it does not independently establish that every declared payload was loaded before cancellation.
- This does not cover decoder/KV/checkpoint state, full-model equivalence, worker-loss resume, or production layout selection.

A real capture should therefore be attached to #167 as one input alongside normal-completion RSS evidence, GPU-side measurements where available, and later full-model relay/cancellation evidence.
