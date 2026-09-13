# Coordinator submit prompt runtime contract

`Coordinator.submitRequest()` is a public runtime boundary. Its TypeScript `string` annotation does not prove that asserted or decoded JavaScript input is actually a string.

The coordinator therefore requires a runtime string before creating request identity or mutating request state. Non-string values fail deterministically before the request counter advances, `activeRequests` changes, a `Pipeline` is constructed, checkpoint/worker state changes, timers are created, or executor work begins.

This guard is intentionally type-only. Existing string semantics are unchanged: empty and whitespace-only strings remain valid submissions. Content policy, normalization, length limits, request ID format, routing, retry, checkpoint, deployment, and billing behavior are outside this contract.

This hardening aligns the in-memory coordinator submission boundary with the durable coordinator's fail-closed runtime posture. It supports #167 reliability work but is not new evidence for real Llama-3.2-1B q4 materialization, physical WebGPU behavior, real multi-browser checkpoint relay/latency, full-vs-multisegment equivalence, or worker-loss resume.
