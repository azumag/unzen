# Two-worker prototype runtime ownership boundary

The fixed two-worker prototype accepts several values that can originate outside the prototype implementation: transport allowlists, worker options, runner dependencies, run options, execution inputs, and relayed checkpoint envelopes. These values are JavaScript trust boundaries even though the prototype itself is simulation-only.

The prototype snapshots the fields it consumes before mutating request, cache, or transport state. Property reads, array classification, array length/index reads, and dependency `instanceof` checks are bounded so revoked proxies and throwing accessors cannot leak caller-controlled/native exceptions through validation. Values thrown by accessors are never stringified or otherwise coerced while producing validation diagnostics.

`AllowlistedPrototypeTransport` does not call caller-owned `.map()` or `Symbol.iterator` while taking its allowlist snapshot. It reads `length` once, rejects lengths outside `0..1024`, then reads each numeric index once before URL canonicalization and deduplication. This keeps hostile proxies from substituting arbitrary iteration behavior or forcing unbounded snapshot work.

The runner validates prompt and URL fields, and checks that both URLs are permitted by the configured transport, before incrementing the request counter or dispatching work. Invalid or hostile run options therefore do not consume a request ID, warm a worker cache, or append transport history.

`SimulatedPrototypeWorker.execute()` similarly snapshots its execution envelope before making any transport connection. Segment 1 snapshots the checkpoint container and copies `hiddenStates` into an owned `Uint8Array` before use. Dependency injection still accepts genuine `AllowlistedPrototypeTransport` and `SimulatedPrototypeWorker` instances, and the existing primary-to-standby retry, checkpoint relay, connection logging, and warm-cache semantics are unchanged.

This hardening is prototype/runtime reliability work only. It is not evidence of real `Llama-3.2-1B-Instruct` q4 execution, physical WebGPU, distinct-browser Coordinator relay/latency, worker-loss/resume, or artifact residency for #167.
