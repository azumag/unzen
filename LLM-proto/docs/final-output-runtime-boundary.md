# Final output runtime boundary

`Pipeline` and `SpanPipeline` accept final output produced by worker/executor code. The TypeScript protocol shape does not make that runtime value trustworthy: an output object or its `tokens` array can be a revoked Proxy, can expose throwing getters/traps, or can override iteration.

`snapshotFinalOutput()` therefore establishes a detached operation-local snapshot before the coordinator accepts the result:

- the output must pass a bounded non-null/non-array record check;
- `tokens` and `text` are read exactly once, in their historical access order, and accessor failures map to the existing final-output validation diagnostics;
- token-array `Array.isArray()`, `length`, and every numeric-index read are bounded so revoked/throwing proxies cannot leak worker exceptions;
- the token array is copied by numeric index and never through `Symbol.iterator`;
- values thrown by worker-controlled getters/traps are never stringified or coerced while handling the failure;
- accepted tokens and the returned snapshot remain newly owned and frozen.

The existing `final segment output` / `final span output` diagnostic prefixes, valid output format, token validity rules, and public pipeline result shape remain unchanged.

This is runtime reliability hardening only. It is not new evidence for real-model execution, physical WebGPU capability, distinct-browser relay/latency, worker-loss recovery, or measured artifact residency.
