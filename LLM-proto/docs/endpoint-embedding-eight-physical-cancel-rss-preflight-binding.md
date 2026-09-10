# 8-physical cancellation RSS preflight provenance binding

`tools/capture_endpoint_embedding_eight_physical_webgpu_cancel_rss_bound.mjs` is a diagnostic wrapper around the existing page-teardown cancellation RSS capture. It preserves the exact validated preflight report supplied to that capture and emits a second, machine-readable provenance sidecar.

The goal is narrow: later analysis must be able to tell which endpoint-embedding graph and eight physical payload identities were declared by the preflight snapshot associated with a saved cancellation RSS envelope. This does **not** upgrade process RSS into GPU device-memory evidence and does not select the 8-physical architecture.

## Why this wrapper exists

The original cancellation RSS evidence intentionally stops the page while an `executing embedding tile N` phase is observed. Because the page is torn down before a complete runtime report exists, the cancellation envelope cannot inherit the complete normal-run runtime report that contains graph and payload identity.

The wrapper closes that provenance gap without changing the browser/runtime contract:

1. read and validate the supplied 8-physical preflight report;
2. reserve the bound-output path before the expensive browser run, failing closed if it already exists;
3. write the validated report to a private temporary snapshot;
4. invoke the existing cancellation capture with the temporary snapshot path, so the harness server cannot accidentally observe a later edit to the operator's original preflight file;
5. re-read the snapshot after the capture and require its canonical SHA-256 to be unchanged;
6. run the existing fail-close cancellation RSS verifier;
7. emit a sidecar containing canonical source-document digests plus a normalized preflight-declared runtime identity for the graph and all eight physical payloads.

The temporary snapshot is mode `0400` and lives in a process-private temporary directory. This is designed to prevent accidental drift during a capture; it is not claimed as an adversarial same-user filesystem isolation boundary. If the capture fails, the reserved bound-output file is removed instead of leaving a partial sidecar.

## Usage

From `LLM-proto/`:

```bash
node tools/capture_endpoint_embedding_eight_physical_webgpu_cancel_rss_bound.mjs \
  /path/to/eight-physical-data \
  /path/to/preflight.json \
  /path/to/embedding-offset-0.onnx \
  /path/to/cancel-rss.json \
  3 \
  /path/to/cancel-rss-bound.json
```

The first five arguments are the same inputs used by `capture_endpoint_embedding_eight_physical_webgpu_cancel_rss.mjs`. The sixth path is reserved exclusively for the provenance sidecar; it must differ from the raw cancellation output path and must not already exist.

A successful sidecar contains:

- canonical SHA-256 of the validated cancellation evidence JSON;
- canonical SHA-256 of the validated preflight snapshot JSON;
- pinned ORT Web version from the browser-harness contract;
- source graph and source external-data identity declared by the preflight;
- manifest payload-set SHA-256;
- executable embedding graph file/bytes/SHA-256 declared by the preflight;
- all eight physical payload index/file/bytes/SHA-256/source ranges declared by the preflight;
- cancellation target tile and observed phase;
- Chrome/CDP/platform identity.

The normalized `runtimeIdentity` intentionally matches the core shape used by the normal-completion GPU-process RSS proxy where possible. That makes a later same-preflight comparison mechanical instead of relying on filenames or operator recollection.

## Evidence boundary

The sidecar uses:

```text
decisionStatus = diagnostic-only
evidenceLevel = derived-captured-os-process-rss+validated-preflight-bundle-identity
```

It proves only that this wrapper invoked the existing cancellation capture using the validated temporary preflight snapshot and that the saved cancellation envelope passed the existing offline verifier. The preflight report remains the source of the prepared-file digests; this wrapper deliberately does not re-hash all 1.05+ GiB of payload data a second time.

In particular, this report does not prove:

- GPU VRAM, WebGPU buffer allocation, driver heap, or device-local working-set size;
- ORT/WebGPU allocator reclamation after cancellation;
- an in-flight ORT cancellation API (the boundary remains `Page.navigate` to `about:blank`);
- that payloads after the cancellation target were loaded or runtime-verified by the cancelled browser run;
- that the preflight report itself was freshly regenerated immediately before this wrapper invocation;
- decoder/KV/checkpoint full-model equivalence or resume correctness;
- that the 8-physical candidate should be promoted to production.

For #167, the next evidence step remains an actual run on a WebGPU-capable host with the real prepared 1B bundle, followed by same-preflight normal/cancellation analysis and the remaining decoder/KV/checkpoint work.
