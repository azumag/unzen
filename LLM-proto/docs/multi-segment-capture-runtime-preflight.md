# Multi-segment capture runtime preflight

`tools/capture_multi_segment_evidence_run.py` is intended to run the expensive host-side #167 evidence path against a real `Llama-3.2-1B-Instruct` q4 artifact. Programmatic callers can bypass `argparse`, so Python annotations alone are not treated as validation.

Before source-model hashing, destination/staging creation, or shard generation, `capture_run()` now preflights the complete set of caller-controlled run parameters that would otherwise fail only after expensive work:

- `token_ids` must contain at least one non-negative integer token ID;
- `kv_heads` and `head_size` must be positive integers;
- `atol` and `rtol` must be finite non-negative numbers;
- the requested ONNX Runtime provider must already be available locally;
- `hidden_size`, `target_bytes`, and `preferred_max_bytes` must satisfy the same positive-integer and browser-budget contract enforced by the budgeted split generator;
- `target_bytes <= preferred_max_bytes <= PREFERRED_MAX_BYTES` remains mandatory.

The numerical parameters are normalized once with `collect_multi_segment_evidence.validate_run_parameters()` and that owned snapshot is used for the later evidence collection and `run-summary.json`. The evidence collector still revalidates the values and provider immediately before ONNX Runtime work; the early capture preflight is an additional fail-fast boundary, not a replacement for the downstream trust boundary.

This prevents an unavailable provider, malformed token/cache-shape parameters, non-finite tolerance, or invalid shard budget from consuming a real 1B split-generation run before failing. It does not download a model, relax artifact limits, deploy production infrastructure, or provide new physical WebGPU / real multi-browser evidence by itself.
