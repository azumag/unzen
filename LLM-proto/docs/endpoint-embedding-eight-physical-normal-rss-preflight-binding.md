# 8-physical normal-completion RSS preflight binding

## Purpose

`tools/capture_endpoint_embedding_eight_physical_webgpu_process_rss_bound.mjs` wraps the existing normal-completion 8-physical endpoint-embedding WebGPU process-RSS capture and binds the resulting evidence to the **exact validated preflight report snapshot supplied to the browser harness**.

This closes a provenance gap for later normal-vs-cancellation comparison. The raw normal RSS capture already embeds a validated runtime report, but without this wrapper there is no persisted, machine-revalidated statement that the runtime report identities match the exact preflight document used for that invocation.

This remains `diagnostic-only` evidence. It does not select the 8-physical layout and does not convert process RSS into direct GPU memory evidence.

## Capture

Run from `LLM-proto/` after producing the 8-physical prepared payload directory and its validated preflight report:

```bash
node tools/capture_endpoint_embedding_eight_physical_webgpu_process_rss_bound.mjs \
  /absolute/path/to/eight-physical-payloads \
  /absolute/path/to/preflight.json \
  /absolute/path/to/embedding-offset-0.onnx \
  /absolute/path/to/normal-rss.json \
  /absolute/path/to/normal-rss-bound.json
```

The wrapper:

1. validates the supplied preflight report;
2. derives its normalized runtime identity and checks its payload-set digest;
3. writes a private, read-only temporary preflight snapshot;
4. runs the existing normal-completion RSS capture against that snapshot;
5. revalidates the snapshot after the browser run and requires its canonical digest to be unchanged;
6. validates the raw normal RSS evidence using the existing fail-close verifier;
7. requires the completed browser runtime report to exactly match the preflight ORT Web version, graph identity, manifest payload-set digest, and all eight physical payload identities;
8. writes both the raw evidence and bound sidecar through caller paths reserved with create-only semantics.

`PROCESS_RSS_OUTPUT_JSON` and `BOUND_OUTPUT_JSON` must be distinct and cannot overwrite the supplied preflight or graph inputs. On wrapper failure, reserved outputs are removed.

## Offline verification

Persist all three documents together:

- `normal-rss-bound.json`
- `normal-rss.json`
- the original `preflight.json`

Revalidate them without launching Chrome or WebGPU:

```bash
node tools/verify_endpoint_embedding_eight_physical_webgpu_process_rss_bound.mjs \
  /path/to/normal-rss-bound.json \
  /path/to/normal-rss.json \
  /path/to/preflight.json
```

The verifier rebuilds the expected sidecar from the validated source documents and requires a canonical JSON SHA-256 exact match. A modified sidecar, substituted RSS capture, preflight drift, runtime/preflight graph mismatch, payload-set mismatch, payload identity mismatch, malformed JSON, unstable input, or symlinked verifier input fails closed.

## Bound identity

The sidecar preserves the normalized preflight identity used by the cancellation binding path where possible:

- source graph SHA-256;
- source external-data identity;
- preflight graph file / bytes / SHA-256;
- manifest payload-set SHA-256;
- eight physical payload indexes, files, bytes, SHA-256 values, and source byte ranges;
- pinned ORT Web version.

For normal completion, the sidecar additionally records that the completed runtime report exactly matched that identity and that the endpoint-embedding comparison and session release contract completed successfully.

This makes same-preflight normal/cancellation comparisons mechanical rather than dependent on filenames or operator recollection.

## Evidence boundary

The sidecar uses:

```text
decisionStatus = diagnostic-only
evidenceLevel = derived-captured-os-process-rss+runtime-report+validated-preflight-bundle-identity
```

It does **not** prove any of the following:

- WebGPU buffer or driver-heap allocation size;
- GPU device-memory / VRAM peak;
- GPU allocator reclamation after release or teardown;
- decoder segmentation correctness;
- KV-state relay correctness;
- checkpoint resume correctness;
- production suitability of the 8-physical layout.

The wrapper validates the captured runtime report and binds it to the exact preflight snapshot; it does not independently re-hash every prepared payload after the run. Real prepared 1B + WebGPU-capable-host measurements are still required for #167.
