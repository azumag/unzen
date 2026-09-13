# Pipeline runtime option contract

`Pipeline` accepts `Partial<PipelineOptions>` at compile time, but runtime callers can still provide decoded/asserted values. Retry and timer controls are therefore validated at construction before request, checkpoint, worker, timer, or executor side effects.

The runtime contract is:

- omitted options retain the existing defaults (`maxRetries=2`, `segmentTimeoutMs=30000`, `retryDelayMs=1000`);
- a supplied options container must be a non-null, non-array object;
- `maxRetries` must be a non-negative safe integer;
- `segmentTimeoutMs` and `retryDelayMs` must be non-negative finite numbers;
- explicit zero remains valid, preserving the existing zero-retry, immediate-timeout, and no-delay semantics.

Malformed values such as `Symbol`, `NaN`, infinities, negative delays/timeouts, or fractional retry counts are rejected deterministically at construction. They cannot enter the retry loop, timer creation, or cause a healthy worker to be selected/disconnected for an invalid caller envelope.

This does not change routing, checkpoint behavior, valid timeout behavior, or retry counts. It is runtime reliability work related to #167 and does not provide new real Llama-3.2-1B q4 materialization, physical WebGPU, real multi-browser relay/latency, or worker-loss-resume evidence.
