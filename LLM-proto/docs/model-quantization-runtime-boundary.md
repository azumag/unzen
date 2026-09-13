# Model quantization runtime boundary

Quantization metadata is validated as untrusted runtime input even though the TypeScript manifest types use strings. `parseQuantizationBits()` returns `NaN` for non-string runtime values without invoking JavaScript string coercion, and manifest validation only compares `runtimeRequirements.supportedQuantization` entries after confirming each compared value is a string.

This prevents malformed objects, proxies, Symbols, or user-defined `toString` / `Symbol.toPrimitive` hooks from escaping validation as incidental exceptions. Valid `q<int>`, `int<int>`, `fp<int>`, and `bf<int>` semantics are unchanged; malformed runtime requirements are reported through the existing validation issues.

This is contract hardening for Issue #630 / #167. It is not new real-model artifact, physical WebGPU working-set, multi-browser relay/latency, or worker-loss evidence.
