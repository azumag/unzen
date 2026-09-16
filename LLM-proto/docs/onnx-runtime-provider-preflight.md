# ONNX Runtime provider-name preflight

The host-side multi-segment evidence collectors treat the requested ONNX Runtime execution provider as a runtime trust-boundary input rather than relying on Python type annotations or CLI parsing.

`collect_multi_segment_evidence.ensure_provider_available()` accepts only a non-empty string containing at least one non-whitespace character. Non-string values, the empty string, and whitespace-only strings fail with `ValueError` before `onnxruntime.get_available_providers()` is queried and before numerical verification can start.

A syntactically valid provider name still follows the existing availability contract: the collector queries ONNX Runtime, records the available providers, and rejects a requested provider that is not present. Provider names are not trimmed or rewritten; callers must supply the exact provider name reported by ONNX Runtime, such as `CPUExecutionProvider`.

This boundary applies to the shared provider preflight used by the same-machine multi-segment evidence path and the cached-decode evidence path. It is host-side validation only and does not constitute new browser/WebGPU evidence for #167.
