# Browser artifact stream AbortSignal ownership

`readResponseBytesBounded()` treats a supplied `AbortSignal` as caller-owned runtime input. The `aborted` state remains a dynamic read at cancellation boundaries so an abort that races with subscription or a stream pull is still observed.

For stream-backed responses, listener capabilities are owned differently. Before the reader is acquired, the bounded reader snapshots `addEventListener` and `removeEventListener` exactly once, requires both values to be callable, and then invokes those captured functions with the original signal as `this`. Cleanup always uses the captured remove method rather than performing a fresh property lookup after asynchronous reads.

This matters for structural or cross-realm signal-like objects whose listener methods can be accessor-backed. A method that was accepted for subscription cannot later be replaced with a throwing or unrelated cleanup method and strand the artifact reader's abort listener on a long-lived signal. A throwing method getter fails closed before reader ownership and the response body is cancellation-cleaned best-effort.

Reader cancellation, listener removal, and reader-lock release remain cleanup operations: cleanup failures must not mask the primary stream validation, cancellation, or successful byte-read outcome. The existing dynamic `aborted` checks before and after reads are unchanged.

This is browser artifact-stream reliability hardening under #167/#992. It does not change artifact budget limits, cache identity, digest verification, model output, deployment, credentials, or production configuration, and it is not new physical WebGPU or multi-browser evidence.
