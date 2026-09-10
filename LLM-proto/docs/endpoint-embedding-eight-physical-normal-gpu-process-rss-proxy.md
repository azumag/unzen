# 8-physical endpoint embedding: normal-completion Chrome GPU-process RSS proxy

Issue: #340  
Parent: #167

## Purpose

`tools/derive_endpoint_embedding_eight_physical_normal_gpu_process_rss_proxy.mjs` derives a read-only Chrome `gpu-process` RSS envelope from an already captured and validated **normal-completion** 8-physical endpoint-embedding process-RSS evidence file.

This complements the cancellation-side proxy from #334/#335. It lets an operator inspect the same Chrome GPU-process OS-RSS role across successful execution, all `InferenceSession.release()` calls returning, the post-release settle window, and document teardown.

The report is **diagnostic-only**. Chrome GPU-process RSS is not GPU device-memory, WebGPU buffer allocation, driver heap accounting, or direct allocator-reclamation evidence.

## Input trust boundary

The analyzer first runs the complete offline validator from `verify_endpoint_embedding_eight_physical_webgpu_process_rss.mjs`. Therefore the source must already satisfy the normal-completion evidence contract, including:

- `status=pass`, `decisionStatus=diagnostic-only`, and `evidenceLevel=captured-os-process-rss`;
- stable Chrome/CDP identity;
- internally consistent process-role totals and total-RSS peak/minimum relationships;
- a passing embedded 8-physical runtime report with byte-exact `[16, 2048]` embedding composition and all session release APIs completed;
- stable, bounded, non-symlink input-file reading with fatal UTF-8 decoding.

After source validation, every observation point emitted by the proxy must contain exactly one process classified as `--type=gpu-process`. Missing or multiple GPU-process roles fail closed.

## Run

From `LLM-proto/`:

```bash
node tools/derive_endpoint_embedding_eight_physical_normal_gpu_process_rss_proxy.mjs \
  /absolute/path/to/eight-physical-rss.json
```

The command writes a machine-readable JSON report to stdout. Redirect it to a new file when evidence retention is desired.

## Reported observations

The proxy records GPU-process RSS for persisted source observations only:

- clean `about:blank` baseline;
- the snapshot at the source capture's **total Chrome-tree** global RSS peak;
- non-control browser phase-peak snapshots, such as `executing embedding tile N`;
- post-release immediate, total-RSS peak, and final snapshots;
- post-teardown immediate, total-RSS peak, minimum, and final snapshots;
- first total-RSS sample at or below baseline, when the source captured one.

The derived `observedPointPeak` is only the largest GPU-process RSS among these persisted observation points. The source capture chose global and phase peaks by **total Chrome-tree RSS**, not GPU-process RSS, so this value must not be described as the true GPU-process peak.

The normal source capture does not persist a release-window minimum. The analyzer deliberately reports release immediate/peak/final only and does not synthesize a missing minimum.

## Recovery summaries

For convenience, the report derives:

- GPU-process RSS and baseline delta at post-release final;
- recovery ratio from the observed-point peak to post-release final;
- GPU-process RSS and baseline delta at post-teardown minimum/final;
- recovery ratio from the observed-point peak to post-teardown minimum;
- whether release-final or teardown-minimum is at/below the original GPU-process baseline.

If no persisted GPU-process observation exceeds baseline, the recovery ratios are `null`; the analyzer does not manufacture an excess-memory denominator.

## Evidence boundary

The generated JSON is fixed to:

```text
kind = unzen-endpoint-embedding-eight-physical-webgpu-normal-gpu-process-rss-proxy
status = pass
decisionStatus = diagnostic-only
evidenceLevel = derived-os-gpu-process-rss-proxy
```

Limitations:

- process RSS can include shared mappings and allocator/cache retention;
- unified-memory platforms cannot separate CPU-resident and GPU-visible pages with this metric;
- sampling can miss short-lived peaks;
- total-RSS-selected snapshots are not GPU-process-selected peaks;
- a decline after session release or document teardown does not prove ORT/WebGPU/driver allocator reclamation;
- this analysis does not select the 8-physical layout and does not establish decoder/KV/checkpoint full-model equivalence or resume correctness.

Real GPU/device-memory telemetry, when available from the target platform or vendor tooling, should be retained as a separate evidence class rather than relabeling this OS-RSS proxy.
