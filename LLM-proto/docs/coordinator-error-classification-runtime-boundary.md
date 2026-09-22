# Coordinator error-classification runtime boundary

Tracking: #1410. Parent technical-core work: #167.

Coordinator catch paths classify arbitrary thrown/runtime values into the closed `ErrorCode` taxonomy. Those values are not trusted merely because the TypeScript source uses `unknown`: a worker/runtime failure can surface a revoked Proxy, a Proxy-wrapped domain error or `AbortSignal`, or an object with throwing accessors.

`errorCodeOf()` therefore bounds both `instanceof UnzenError` and the subsequent `.code` read. Only a string that is already in the closed `ErrorCode` set is returned. An unreadable, revoked, or malformed domain-error value produces `undefined` rather than escaping classification.

Cancellation detection is similarly bounded. Reading a DOMException-style `.name`, classifying a value with `instanceof AbortSignal`, and reading `signal.aborted` are each isolated operations. A genuine `AbortError` or already-aborted real `AbortSignal` still maps to `user-cancelled`; hostile/unreadable values fall through to `runtime-transient`. No message parsing or object/function string coercion is used.

This hardening does not change retry/isolation policy, lease or checkpoint semantics, protocol/API schemas, dispatcher behavior, or the meaning of any valid `ErrorCode`. It is runtime reliability hardening only and is not new real-model, physical WebGPU, distinct-browser relay/latency, worker-loss/resume, or residency evidence for #167.
