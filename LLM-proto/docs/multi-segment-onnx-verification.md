# Budgeted multi-segment ONNX correctness verification

Issue #167 scales the proven small-model path to a 1B-class q4 model without
relaxing the browser artifact budget. Planning and artifact generation alone do
not prove that the extracted N-segment graph is numerically equivalent to the
source model, so a same-machine correctness gate is required before real
multi-browser WebGPU execution.

## Prepare browser-sized artifacts

Use the budget-driven generator:

```bash
python tools/multi_segment_onnx.py \
  /absolute/path/to/Llama-3.2-1B-Instruct/onnx/model_q4.onnx \
  /absolute/path/to/llama-1b-budget-split
```

The generator chooses contiguous layer spans, targets roughly 200 MiB per
browser artifact, requires every generated artifact to remain within the
preferred 256 MiB ceiling, repacks external data independently per segment and
writes the measured plan to `split-manifest.json`.

## Run full-vs-multi-segment verification

Use the exact token IDs that will be used for the browser run:

```bash
python tools/verify_multi_segment_onnx.py \
  --full-model /absolute/path/to/Llama-3.2-1B-Instruct/onnx/model_q4.onnx \
  --manifest /absolute/path/to/llama-1b-budget-split/split-manifest.json \
  --input-ids '128000,2028,374,264,1296' \
  --kv-heads 8 \
  --head-size 64
```

The numerical verifier first repeats the stdlib-only artifact-integrity
preflight. No ONNX Runtime session is created until the manifest digest, every
segment graph digest, external-data digest/byte count and browser-artifact budget
have been revalidated. It then verifies that `--full-model` has the exact graph
SHA-256 recorded in `sourceModel` at split time. Source external-data byte counts
are always checked and their SHA-256 values are checked when the generator
recorded them (the default real-artifact path hashes them).

This identity binding prevents a passing numerical result from being saved next
to a preflight report for a different or later-modified artifact set. The final
numerical JSON embeds both the complete `artifactIntegrity` report and the
measured `sourceModel` identity, including the manifest SHA-256 used for that
same invocation.

The verifier also fails before creating an ONNX Runtime session when the
manifest is not the measured `unzen-budgeted-multi-segment-onnx` format, segment
layer spans are not contiguous, cut layers disagree with the segment layout, a
segment/source external-data path escapes its artifact directory, or a boundary
tensor is not both produced by the preceding segment and consumed by the
following segment.

Execution is intentionally sequential:

```text
full model -> logits reference
segment 0  -> boundary 0
segment 1  -> boundary 1
...
segment N  -> logits candidate
```

Only one ONNX Runtime session is retained at a time. Intermediate boundary
arrays remain in memory only until the next segment consumes them. The final
report records every observed boundary shape/dtype/byte count, total relayed
bytes, cut layers, full/split logits shapes and maximum absolute difference,
and the last-token top-1 IDs.

A `status=pass` result requires both `numpy.allclose()` under the configured
absolute/relative tolerances and identical last-token top-1 IDs. A passing
same-machine result is automated correctness evidence only; it does not replace
#167's required real multi-browser WebGPU, Coordinator-relay, cache and latency
evidence.
