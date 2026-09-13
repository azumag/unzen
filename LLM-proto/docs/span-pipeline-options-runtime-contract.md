# SpanPipeline runtime option contract

`SpanPipeline` options may cross decoded/asserted JavaScript boundaries even though callers normally see `Partial<SpanPipelineOptions>` at compile time. They are therefore validated before any artifact-residency check or later request/worker side effect.

The runtime contract is:

- omitted options use the existing defaults (`maxRetries=2`, `perSegmentTimeoutMs=10000`, `retryDelayMs=1000`);
- a supplied options container must be a non-null, non-array object;
- `maxRetries` must resolve to a non-negative safe integer;
- `perSegmentTimeoutMs` must resolve to a non-negative finite number;
- `retryDelayMs` must resolve to a non-negative finite number;
- explicit zero remains valid: zero retries means only the initial route, zero timeout remains an immediate timeout, and zero retry delay remains no delay.

Malformed values fail at construction before `ArtifactResidencyLedger.assertCompatibleSegments()`, request mutation, worker selection/busy-state mutation, timer creation, or executor invocation. This avoids JavaScript coercion or values such as `Symbol`, `NaN`, infinities, negative delays, or fractional retry counts escaping into retry/timer control flow.

This change does not alter routing policy, span timeout scaling, checkpoint semantics, or browser artifact policy. It is runtime reliability work related to #167, not new real Llama-3.2-1B q4 materialization, physical WebGPU, multi-browser relay/latency, or worker-loss-resume evidence.
