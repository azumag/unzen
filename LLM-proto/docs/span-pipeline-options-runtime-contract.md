# SpanPipeline runtime option contract

`SpanPipeline` options may cross decoded/asserted JavaScript boundaries even though callers normally see `Partial<SpanPipelineOptions>` at compile time. Accessor-backed objects and Proxies are therefore treated as caller-owned input: declared fields are captured into a new owned option envelope and validated before any artifact-residency check or later request/worker side effect.

The runtime contract is:

- omitted options use the existing defaults (`maxRetries=2`, `perSegmentTimeoutMs=10000`, `retryDelayMs=1000`);
- a supplied options container must be a non-null, non-array object;
- caller-owned options are not spread or enumerated; only own-enumerable `maxRetries`, `perSegmentTimeoutMs`, `retryDelayMs`, and `artifactResidencyLedger` are eligible to be read;
- inherited and non-enumerable declared-name properties remain ignored, matching the previous object-spread behavior;
- each accepted declared field is read at most once, so valid-first/altered-second accessors cannot drift between validation and retained state;
- unrelated enumerable properties and Proxy `ownKeys` traps cannot run as an option-resolution side effect;
- numeric controls are captured and validated before `artifactResidencyLedger` is read, preserving a fail-fast boundary for malformed retry/timer input;
- defaults are applied only when the corresponding accepted captured numeric field is `undefined`;
- `maxRetries` must resolve to a non-negative safe integer;
- `perSegmentTimeoutMs` must resolve to a non-negative finite number;
- `retryDelayMs` must resolve to a non-negative finite number;
- `artifactResidencyLedger`, when supplied as an own-enumerable field, retains its original object identity and `assertCompatibleSegments()` still runs only after the numeric envelope is valid;
- explicit zero remains valid: zero retries means only the initial route, zero timeout remains an immediate timeout, and zero retry delay remains no delay.

Malformed values fail at construction before `ArtifactResidencyLedger.assertCompatibleSegments()`, request mutation, worker selection/busy-state mutation, timer creation, or executor invocation. This avoids JavaScript coercion or values such as `Symbol`, `NaN`, infinities, negative delays, or fractional retry counts escaping into retry/timer control flow, while also preventing unrelated caller getters from expanding the construction trust boundary.

This change does not alter routing policy, span timeout scaling, checkpoint semantics, or browser artifact policy. It is runtime reliability work related to #167, not new real Llama-3.2-1B q4 materialization, physical WebGPU, multi-browser relay/latency, or worker-loss-resume evidence.
