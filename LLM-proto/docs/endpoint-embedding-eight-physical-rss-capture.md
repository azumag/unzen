# 8-physical endpoint embedding WebGPU process-RSS capture

## Purpose

`tools/capture_endpoint_embedding_eight_physical_webgpu_process_rss.mjs` wraps the isolated 8-physical endpoint-embedding ORT Web/WebGPU harness from #326/#327 in a fresh Chrome process and records the host OS resident-set-size (RSS) envelope for that launched Chrome process tree.

This closes a tooling gap in #167: the browser harness already records per-tile `InferenceSession.create()`, `run()`, and `release()` timings, but those self-reported timings do not show the host working-set envelope or what happens after the release promises return.

The capture remains **diagnostic-only**. It does not select the 8-physical layout, modify the production cache/dispatcher/runtime contract, or claim to measure exact WebGPU/driver allocations.

## Preconditions

Prepare the real 1B source and generate the 8-physical candidate as described by the existing payload preparation documentation. Run the actual-file preflight first. The capture server will independently re-validate the supplied preflight before opening its listener, and the browser will re-hash the graph and each payload immediately before use.

The capture command needs four explicit paths:

1. directory containing `payload-0000.bin` through `payload-0007.bin`;
2. passing actual-file preflight JSON;
3. pinned `embedding-offset-0.onnx` graph;
4. output JSON path.

## Run

From `LLM-proto/`:

```bash
node tools/capture_endpoint_embedding_eight_physical_webgpu_process_rss.mjs \
  /absolute/path/to/eight-physical-payloads \
  /absolute/path/to/eight-physical-preflight.json \
  /absolute/path/to/embedding-offset-0.onnx \
  /absolute/path/to/eight-physical-rss.json
```

On Linux, set `CHROME_BINARY` when `google-chrome` is not on `PATH`. On macOS the default is `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`.

Optional environment controls:

| Variable | Default | Constraint |
| --- | ---: | --- |
| `UNZEN_HARNESS_PORT` | `8797` | integer `1..65535`, distinct from CDP port |
| `UNZEN_CDP_PORT` | `9337` | integer `1..65535`, distinct from harness port |
| `UNZEN_RSS_SAMPLE_INTERVAL_MS` | `100` | positive safe integer |
| `UNZEN_RSS_POST_REPORT_SETTLE_MS` | `5000` | non-negative safe integer |
| `UNZEN_RSS_POST_TEARDOWN_SETTLE_MS` | `30000` | non-negative safe integer |
| `UNZEN_RSS_TIMEOUT_MS` | `180000` | positive safe integer |

Malformed values fail before the harness or Chrome is launched.

## Fail-close runtime evidence contract

A browser report is accepted only when all of the following hold:

- runtime kind is exactly `unzen-pinned-llama-1b-endpoint-embedding-eight-physical-ort-webgpu-runtime`;
- `status=pass`;
- `decisionStatus=diagnostic-only` and `selectedPhysicalArtifactCount=null`;
- `evidenceLevel=self-reported-runtime`;
- exactly eight verified physical artifacts and eight executed tiles are present in index order;
- every tile is routed 1:1 to the same-index physical artifact and carries the same payload identity;
- every per-tile comparison and the complete `[16, 2048]` comparison are byte-exact;
- all create/run/release durations are finite and non-negative;
- `sessionReleaseApiCompleted=true`.

This prevents the host-side RSS capture from promoting a partial, reordered, mismatched, or merely tolerance-close browser run into accepted evidence.

## Captured milestones

The output records:

- baseline RSS while the fresh Chrome profile is still on `about:blank`;
- global sampled peak across the measured run;
- per-browser-phase sampled RSS peaks;
- the immediate RSS sample when the validated passing browser report is observed;
- the peak and final RSS during the post-release settle window;
- RSS after navigating the measured page to `about:blank`;
- the minimum/final RSS during the document-teardown settle window and the first observed sample at or below baseline, when one occurs.

RSS is the sum of the launched Chrome root process and descendants discovered by PPID. Unrelated Chrome instances are not intentionally included.

## Offline re-validation

A persisted normal-completion capture can be re-validated without launching Chrome or WebGPU again:

```bash
node tools/verify_endpoint_embedding_eight_physical_webgpu_process_rss.mjs \
  /absolute/path/to/eight-physical-rss.json
```

The verifier re-checks the diagnostic schema/decision boundary, Chrome executable versus CDP browser identity, RSS role totals and milestone ordering, the embedded 8-physical runtime report, and the release/teardown phase-peak relationships. Input is read as a stable non-symlink regular-file snapshot with a default 16 MiB bound, fatal UTF-8 decoding, and pathname/device/inode/size/mtime/ctime consistency checks across the read. Set `UNZEN_PROCESS_RSS_EVIDENCE_MAX_BYTES` only when a larger trusted evidence envelope is intentionally required; accepted values are `1..268435456` bytes.

A passing offline verification only proves that the persisted evidence is internally consistent with the capture contract. It is not a substitute for performing the real WebGPU capture on the intended host.

## GPU-process RSS proxy derivation

After offline verification, derive the Chrome `--type=gpu-process` OS-RSS observations without re-running Chrome:

```bash
node tools/derive_endpoint_embedding_eight_physical_normal_gpu_process_rss_proxy.mjs \
  /absolute/path/to/eight-physical-rss.json
```

See `docs/endpoint-embedding-eight-physical-normal-gpu-process-rss-proxy.md` for the exact observation set and evidence boundary. The derived peak is only the maximum GPU-process RSS among persisted snapshots selected by the source capture; it is not a direct GPU-memory peak measurement.

## Evidence boundary

The generated JSON uses:

```text
kind = unzen-endpoint-embedding-eight-physical-webgpu-process-rss-diagnostic
status = pass
decisionStatus = diagnostic-only
evidenceLevel = captured-os-process-rss
```

Important limitations remain:

- RSS is not an exact WebGPU, Metal, Vulkan, D3D12, or ORT allocator metric;
- shared mappings can be double-counted when process RSS values are summed;
- unified-memory systems cannot cleanly separate CPU-resident and GPU-visible pages using RSS;
- peaks shorter than the sampling interval can be missed;
- a lower RSS after `release()` is observational and does not prove immediate allocator reclamation;
- navigating to `about:blank` tears down the measured document but the browser/driver may retain reusable process or allocator state;
- this embedding-only run does not prove decoder/KV/checkpoint full-model numerical equivalence.

CI validates the argument and runtime-report contracts without launching Chrome or requiring the real 1B bundle. A committed or reported RSS result must therefore come from an explicitly executed real-browser capture, not from the CI contract tests.
