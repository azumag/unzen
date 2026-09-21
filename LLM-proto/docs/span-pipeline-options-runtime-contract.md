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
- `perSegmentTimeoutMs` must resolve to a non-negative finite number no greater than `2147483647ms` (`MAX_TIMER_DELAY_MS`);
- `retryDelayMs` must resolve to a non-negative finite number no greater than `2147483647ms`;
- `artifactResidencyLedger`, when supplied as an own-enumerable field, retains its original object identity and `assertCompatibleSegments()` still runs only after the numeric envelope is valid;
- explicit zero remains valid: zero retries means only the initial route, zero timeout remains an immediate timeout, and zero retry delay remains no delay.

## Hostile accessor and Proxy boundary

Top-level record classification is bounded, including the `Array.isArray()` call used to reject arrays. A revoked options Proxy therefore fails through `SpanPipeline options must be a non-null, non-array object` rather than leaking a native Proxy exception. Declared-field descriptor lookup and value access are guarded independently: a throwing descriptor trap fails with `SpanPipeline option <field> could not be inspected`, while a throwing declared getter/value trap fails with `SpanPipeline option <field> could not be read`.

Caller-thrown values are discarded without inspection, stringification, or coercion, so failure handling cannot execute hostile `toString()` or `Symbol.toPrimitive` hooks. The guards preserve own/enumerable filtering, declared-field order, no-`ownKeys` behavior, and successful read-once semantics. Numeric fields are still resolved before `artifactResidencyLedger`, so an earlier hostile numeric option cannot trigger residency dependency getters or compatibility checks.

The upper bound reflects the signed 32-bit range used by browser/Node timers. Values above it are rejected rather than silently overflowing into a much shorter or immediate timer. A multi-segment span can still exceed the limit after `spanSize * perSegmentTimeoutMs`; that derived deadline is preflighted for the entire selected route before any worker is marked busy or the executor is invoked.

Malformed or unsupported values fail at construction before `ArtifactResidencyLedger.assertCompatibleSegments()`, request mutation, worker selection/busy-state mutation, timer creation, or executor invocation. This avoids JavaScript coercion or values such as `Symbol`, `NaN`, infinities, negative delays, fractional retry counts, or unrepresentable host-timer delays escaping into retry/timer control flow, while also preventing unrelated caller getters from expanding the construction trust boundary.

This change does not alter routing policy, checkpoint semantics, or browser artifact policy. It is runtime reliability work related to #167, not new real Llama-3.2-1B q4 materialization, physical WebGPU, multi-browser relay/latency, or worker-loss-resume evidence.
