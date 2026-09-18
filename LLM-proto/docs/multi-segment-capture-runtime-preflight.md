# Multi-segment capture runtime preflight

`tools/capture_multi_segment_evidence_run.py` is intended to run the expensive host-side #167 evidence path against a real `Llama-3.2-1B-Instruct` q4 artifact. Programmatic callers can bypass `argparse`, so Python annotations alone are not treated as validation.

Before source-model hashing, staging creation, or shard generation, `capture_run()` now preflights the caller-controlled run parameters that would otherwise fail only after expensive work:

- `token_ids` must contain at least one non-negative integer token ID;
- `kv_heads` and `head_size` must be positive integers;
- `atol` and `rtol` must be finite non-negative numbers;
- `hidden_size`, `target_bytes`, and `preferred_max_bytes` must satisfy the same positive-integer and browser-budget contract enforced by the budgeted split generator;
- `target_bytes <= preferred_max_bytes <= PREFERRED_MAX_BYTES` remains mandatory;
- the requested ONNX Runtime provider must already be available locally.

The numerical and budget option checks run before destination inspection. The existing destination contract is preserved: an occupied destination is still rejected before the runner queries ONNX Runtime provider availability. Provider availability is then checked before source hashing, staging-directory creation, or generator invocation.

The numerical parameters are normalized once with `collect_multi_segment_evidence.validate_run_parameters()` and that owned snapshot is used for the later evidence collection and `run-summary.json`. The evidence collector still revalidates the values and provider immediately before ONNX Runtime work; the early capture preflight is an additional fail-fast boundary, not a replacement for the downstream trust boundary.

Capture treats both artifact-integrity verifier reports as untrusted runtime boundaries: the stable preflight report before numerical work and the artifact-integrity report embedded by the numerical collector before publication. Each passing integrity report is validated independently and must carry `segmentCount`, `maximumSegmentArtifactBytes`, and `effectiveRequiredMaxBytes` as exact positive Python integers. The stable snapshot envelope independently requires its own `segmentCount` to be an exact positive integer before comparing it with the nested integrity count. Booleans are rejected explicitly even though Python makes `bool` a subclass of `int`, so `True == 1` cannot let malformed embedded or envelope metadata impersonate a valid one-segment report. This keeps mocked, programmatic, or future verifier changes from turning boolean metadata into measured count/byte values.

This prevents an unavailable provider, malformed token/cache-shape parameters, non-finite tolerance, invalid shard budget, or malformed artifact-integrity/snapshot metadata from consuming or publishing a real 1B numerical capture before failing. It does not download a model, relax artifact limits, deploy production infrastructure, or provide new physical WebGPU / real multi-browser evidence by itself.
