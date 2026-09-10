# 8-physical cancellation RSS evidence offline verification

## Purpose

`tools/verify_endpoint_embedding_eight_physical_webgpu_cancel_rss.mjs` revalidates a persisted JSON report produced by `tools/capture_endpoint_embedding_eight_physical_webgpu_cancel_rss.mjs` without launching Chrome, ONNX Runtime, or WebGPU.

The verifier exists so a cancellation RSS capture can be checked again before it is cited as diagnostic evidence under #167. It does not promote the 8-physical candidate and it does not turn host RSS into GPU-allocation evidence.

## Run

From `LLM-proto/`:

```bash
node tools/verify_endpoint_embedding_eight_physical_webgpu_cancel_rss.mjs \
  /path/to/cancel-rss.json
```

The input is limited to 16 MiB by default. The ceiling can be lowered or raised, up to 256 MiB, when an operator has a specific reason:

```bash
UNZEN_CANCEL_RSS_EVIDENCE_MAX_BYTES=8388608 \
node tools/verify_endpoint_embedding_eight_physical_webgpu_cancel_rss.mjs \
  /path/to/cancel-rss.json
```

A successful verification prints a compact summary and exits with status 0. Any contract, file-integrity, UTF-8, JSON, or measurement-consistency failure exits non-zero.

## Evidence contract

The verifier fails closed unless the persisted report retains the cancellation capture contract:

- schema `1.0.0`, the exact cancellation-RSS evidence kind, `status=pass`, and `decisionStatus=diagnostic-only`,
- evidence level `captured-os-process-rss-after-page-teardown-cancellation`,
- a canonical UTC capture timestamp,
- supported host platform, positive host-memory size, and minimally valid OS/Node identity,
- a four-part Chrome version matching the live CDP `Chrome`/`HeadlessChrome` version,
- cancellation tile `0..7` with exact matching `expectedPhase` and `observedPhase`,
- no passing/failing runtime report already present at the cancellation trigger,
- the pinned CDP `Page.navigate` cancellation method,
- the pinned RSS metric, unit, and Chrome process-tree aggregation description.

Each RSS snapshot is also internally checked: role process counts and role RSS totals must exactly add up to the snapshot-level values. The global peak must dominate every persisted phase/post-cancel sample, while the post-cancel peak and minimum must bound the immediate, final, and optional baseline-recovery observations consistently. The stored baseline copy and the baseline/post-cancel phase peaks must agree with their corresponding measurement snapshots.

## Stable bounded input read

Verification is deliberately read-only and does not trust a pathname merely because it ends in `.json`.

Before parsing, the verifier:

1. requires the path to be a non-symlink regular file,
2. enforces the configured byte ceiling before allocation,
3. opens with `O_NOFOLLOW` where the platform exposes it,
4. checks the path and descriptor `(device, inode, size, mtime, ctime)` identities,
5. performs a bounded read and detects growth/shrinkage during the read,
6. checks the same descriptor/path metadata again after the read,
7. decodes UTF-8 in fatal mode before JSON parsing.

This prevents a replaced pathname, symlink, growing file, malformed byte stream, or unexpectedly large artifact from being silently treated as verified evidence.

## Interpretation limits

A passing offline verification means the persisted file is structurally and internally consistent with the capture contract. It does **not** prove that RSS is a direct GPU-memory measurement, that WebGPU allocations were reclaimed at a particular instant, or that ONNX Runtime provides an in-flight cancellation primitive. Page navigation remains a coarse document-lifecycle cancellation boundary.

The report therefore remains one diagnostic input alongside normal-completion host-memory captures, closest-available GPU-side measurements, and the still-pending decoder/KV/checkpoint full-model staged relay/equivalence/resume evidence. No production manifest, cache, loader, runtime, dispatcher, artifact-budget, or physical-layout decision is made by this verifier.
