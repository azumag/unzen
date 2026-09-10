# 8-physical endpoint embedding: Chrome GPU-process RSS proxy

Issue: #334  
Parent: #167

## Purpose

The 8-physical WebGPU cancellation capture records RSS for the Chrome root process and each classified child-process role. This document defines a narrow derived diagnostic that extracts the `--type=gpu-process` role from a cancellation capture that has already passed the fail-close verifier from #332/#333.

The result is useful as the closest portable process-local proxy already present in the evidence envelope. It is **not** GPU device-memory accounting and must not be described as VRAM, WebGPU allocation bytes, a driver heap, or proof that the GPU allocator reclaimed memory.

## Input trust boundary

Only persisted cancellation RSS evidence accepted by:

```bash
node tools/verify_endpoint_embedding_eight_physical_webgpu_cancel_rss.mjs \
  /path/to/cancel-rss.json
```

is accepted. The derived analyzer calls the same stable-file reader and source validator itself, so callers do not need to trust a separately executed verification step.

The source verifier already fail-closes on schema and decision drift, Chrome/CDP identity mismatch, invalid RSS role aggregates, inconsistent peak/minimum relationships, symlinks, oversized input, invalid UTF-8, and file/path identity changes during a read.

## Run

From `LLM-proto/`:

```bash
node tools/derive_endpoint_embedding_eight_physical_gpu_process_rss_proxy.mjs \
  /path/to/cancel-rss.json \
  > /path/to/gpu-process-rss-proxy.json
```

The analyzer is read-only with respect to the source capture. It does not start Chrome, WebGPU, ORT, Cloudflare, or any external service.

## Derived observation points

The report requires exactly one Chrome process classified as `gpu-process` at every selected source snapshot and extracts its RSS at:

- baseline `about:blank`,
- the source snapshot whose **total Chrome-tree RSS** is globally maximal,
- the cancellation target phase peak selected by total Chrome-tree RSS,
- immediately before cancellation,
- immediately after `about:blank` becomes ready,
- post-cancel settle peak selected by total Chrome-tree RSS,
- post-cancel settle minimum selected by total Chrome-tree RSS,
- the final post-cancel sample,
- the first total-RSS-at-or-below-baseline sample when present.

The analyzer then reports baseline-relative deltas and `observedPointPeak`, which is the maximum GPU-process RSS among only those persisted points. This name is deliberate: the original sampler chooses its peak snapshots by **whole Chrome-tree RSS**, so the derived report cannot claim that it observed the true GPU-process RSS peak between samples.

`peakExcessRecoveryRatioAtPostCancelMinimum` is computed only when the observed GPU-process RSS peak exceeds baseline:

```text
(observedPointPeak - postCancelMinimum) /
(observedPointPeak - baseline)
```

A value above `1.0` means the selected post-cancel minimum fell below the selected baseline. It still does not prove that WebGPU or driver allocations were reclaimed.

## Output contract

The report is fixed to:

- `status=pass`
- `decisionStatus=diagnostic-only`
- `evidenceLevel=derived-os-gpu-process-rss-proxy`
- source capture timestamp, target tile, expected phase, Chrome/CDP identity, platform, sample interval and sample count
- exactly one `gpu-process` at every derived point
- RSS values in KiB plus signed baseline deltas

Missing `gpu-process` attribution or more than one process under that role is rejected rather than silently aggregating an ambiguous process set.

## Interpretation limits

Chrome GPU-process RSS is host OS resident-memory accounting. Shared mappings can be charged into RSS; on unified-memory machines the metric cannot separate CPU-resident pages from pages visible to the GPU. Device-local memory, driver heaps, WebGPU buffer/texture allocations, transient command resources, and allocator caches are outside this metric.

The original RSS sampler is interval-based and can miss short peaks. In addition, its saved `globalPeak` and phase peaks are chosen using total Chrome-tree RSS, not GPU-process RSS. Therefore this derived evidence is supporting evidence for #167, not a substitute for vendor/platform-specific GPU-memory telemetry when such telemetry can be captured safely on the real test host.

A decline after page teardown is observational only. It does not establish ORT/WebGPU in-flight cancellation semantics, direct allocator reclamation, 8-physical production suitability, or decoder/KV/checkpoint full-model equivalence and resume correctness.
