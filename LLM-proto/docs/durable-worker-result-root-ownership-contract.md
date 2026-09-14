# Durable worker result root ownership contract

`DurableCoordinator.acceptResult()` treats a worker-supplied `ExecutionResult` as untrusted runtime input. The public coordinator boundary detaches the stable result identity and processing-time fields before the durable core performs repository lookup, cancellation handling, lease matching, accounting, or commit work.

## Captured root fields

For a structurally valid identity object, `requestId`, `attemptId`, `leaseId`, `workerId`, `workerGeneration`, and `segmentIndex` are each captured once into a fresh plain identity. `processingTimeMs` is then captured once. The existing durable core remains authoritative for exact protocol-violation messages and state-machine behavior.

The snapshot preserves the existing fail-fast order. If an identity field is invalid, later identity fields, `processingTimeMs`, `output`, and `checkpoint` are not read from the caller. If `processingTimeMs` is invalid, neither branch payload is read.

## Lazy branch payload references

`output` and `checkpoint` intentionally remain branch-lazy. The public wrapper does not eagerly read either field because the core may reject the result for a missing request, cancellation, or lease mismatch before deciding whether the result is final or intermediate.

When the core reaches the relevant branch for the first time, that top-level property is read once from the caller and memoized. Repeated core reads therefore observe the same top-level object reference without re-running the caller getter. The opposite branch is never touched merely by snapshot construction.

Nested final-output fields (`tokens`, `text`) and nested checkpoint-envelope fields remain separate trust-boundary work. This contract stabilizes only the result root, the complete result identity, `processingTimeMs`, and the top-level `output` / `checkpoint` references.

## Evidence boundary

This is runtime ownership / TOCTOU hardening. It does not provide new physical WebGPU, real multi-browser relay, real Llama q4 artifact, production deployment, credential, billing, or operator-authorization evidence for #167 or #158.
