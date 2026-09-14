# Pipeline runtime option contract

`Pipeline` accepts `Partial<PipelineOptions>` at compile time, but runtime callers can still provide decoded/asserted values, accessor-backed objects, or Proxies. Retry and timer controls are therefore captured into a new owned option envelope and validated at construction before request, checkpoint, worker, timer, or executor side effects.

The runtime contract is:

- omitted options retain the existing defaults (`maxRetries=2`, `segmentTimeoutMs=30000`, `retryDelayMs=1000`);
- a supplied options container must be a non-null, non-array object;
- only the declared `maxRetries`, `segmentTimeoutMs`, and `retryDelayMs` fields are read; caller-owned options are not spread or enumerated;
- each declared field is read at most once, and that captured value is used for default selection, validation, and retained runtime state;
- unrelated enumerable properties and Proxy `ownKeys` traps are outside option resolution and cannot run as a side effect of constructing a `Pipeline`;
- defaults are applied only when a captured declared field is `undefined`;
- `maxRetries` must be a non-negative safe integer;
- `segmentTimeoutMs` and `retryDelayMs` must be non-negative finite numbers;
- explicit zero remains valid, preserving the existing zero-retry, immediate-timeout, and no-delay semantics.

Malformed values such as `Symbol`, `NaN`, infinities, negative delays/timeouts, or fractional retry counts are rejected deterministically at construction. They cannot enter the retry loop, timer creation, or cause a healthy worker to be selected/disconnected for an invalid caller envelope. A valid-first/altered-second accessor also cannot make the value accepted during validation differ from the value retained by the pipeline.

This does not change routing, checkpoint behavior, valid timeout behavior, or retry counts. It is runtime reliability work related to #167 and does not provide new real Llama-3.2-1B q4 materialization, physical WebGPU, real multi-browser relay/latency, or worker-loss-resume evidence.
