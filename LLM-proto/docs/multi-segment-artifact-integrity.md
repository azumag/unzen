# Multi-segment artifact integrity preflight

`tools/multi_segment_onnx.py` emits a measured `split-manifest.json`, but a real
1B run may happen later or on another machine. Before spending memory and GPU
time on ONNX Runtime, verify that the files on disk are still exactly the files
that the manifest describes.

Run this immediately after generation and again on the machine that will execute
the numerical or browser test:

```bash
python tools/verify_multi_segment_artifacts.py \
  --manifest /absolute/path/to/llama-1b-budget-split/split-manifest.json \
  > /absolute/path/to/llama-1b-budget-split/artifact-integrity.json
```

The preflight is stdlib-only and does not create an ONNX Runtime session. It
fails closed if any of the following changed or no longer agrees with the
manifest:

- segment graph SHA-256;
- external-data SHA-256 or byte length;
- graph + external-data `browserArtifactBytes`;
- per-segment browser artifact tier;
- the duplicated per-segment budget ledger;
- `maximumSegmentArtifactBytes` / `maximumGeneratedSegmentBytes`;
- the effective required maximum (`min(browserArtifactBudget.requiredMaxBytes,
  splitPlan.requiredMaxBytes)`);
- relative artifact paths.

A successful report records the manifest digest, every measured graph and
external-data size/digest, the measured maximum segment size, and the effective
required budget. Keep this JSON next to the later correctness and browser
reports so evidence from a different or modified artifact set cannot be mixed
accidentally.

After this preflight passes, continue with the numerical gate:

```bash
python tools/verify_multi_segment_onnx.py \
  --full-model /absolute/path/to/Llama-3.2-1B-Instruct/onnx/model_q4.onnx \
  --manifest /absolute/path/to/llama-1b-budget-split/split-manifest.json \
  --input-ids '128000,2028,374,264,1296'
```

The numerical verifier deliberately repeats this integrity preflight immediately
before creating ONNX Runtime sessions and embeds the resulting report in its own
JSON. It also binds the full-model reference to `sourceModel.sha256` and checks
source external-data sizes/digests when present. The standalone preflight remains
useful as a cheap post-generation or transfer-time gate, while the repeated gate
prevents a numerical report from silently referring to a stale or different
artifact set.

For issue #167, these checks are automated/host-side integrity evidence only.
They do not prove WebGPU execution, distinct browser workers, Coordinator relay,
cache behavior, or relay latency; those still require real browser evidence.
