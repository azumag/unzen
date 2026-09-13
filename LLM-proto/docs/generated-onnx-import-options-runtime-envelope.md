# Generated ONNX import options runtime envelope

`importGeneratedOnnxSplitManifest()` receives both generated split metadata and caller-supplied import options. TypeScript annotations do not make the latter trusted at runtime, so the options envelope is validated before the generated manifest is parsed or any runtime manifest is constructed.

The top-level options value must be a non-null, non-array object. Model metadata strings, parameter count, source, artifact base URL, memory estimates, memory basis, optional measurement conditions, compatible runtimes, and the top-level minimum runtime version are validated before use. In particular, `artifactBaseUrl` must be an actual string before `URL` parsing or diagnostic interpolation, avoiding implicit coercion paths such as `Symbol` values.

`runtimeRequirements` is independently required to be an object before spread or field access. Its `minimumVramMB` must be a positive finite number; `supportedQuantization` must be a non-empty array of supported quantization-form strings; and its minimum runtime and Chrome versions must be non-empty strings. The accepted memory basis remains the closed `measured | budgeted | estimated` set.

This preflight does not change valid import semantics: per-segment versus shared memory estimates, URL normalization, source policy, generated artifact geometry/budget checks, bundle digest construction, and final model-manifest validation remain authoritative. Length matching for per-segment memory estimates still occurs after the generated segment count is known.

Focused coverage is in `tests/generated-onnx-import-options-envelope.test.ts`. It exercises malformed top-level containers, coercion-sensitive URL values, memory metadata, nested runtime requirements, and the normal valid import path.

This is import/runtime trust-boundary hardening only. It is not real Llama-3.2-1B q4 artifact materialization, physical WebGPU memory evidence, real multi-browser checkpoint relay, worker-loss resume, or production deployment evidence for #167/#158.
