# Durable worker failure ownership contract

`DurableCoordinator.handleWorkerFailure()` treats a pushed `ExecutionFailure` as untrusted runtime input. The public coordinator boundary detaches the failure identity and payload fields before the durable core can use them for lease/state mutation.

## Owned envelope

For a structurally valid identity object, `requestId`, `attemptId`, `leaseId`, `workerId`, `workerGeneration`, and `segmentIndex` are each captured once into a fresh plain identity. `code` and `message` are then captured into the same owned failure envelope. The existing core handler remains authoritative for ProtocolViolation errors, cancellation precedence, lease matching, attempt accounting, lease reclaim, and worker isolation.

The snapshot preserves the core validator's fail-fast field order. If an identity field is invalid, later identity fields and top-level `code` / `message` are not read from the caller. If `code` is invalid, `message` is not read. This prevents hardening itself from executing getters that the pre-existing validator would never have reached.

Declared failure fields continue to use normal JavaScript property lookup. The change is about ownership and read count, not a new enumerable/own-property policy.

## Evidence boundary

This is runtime ownership / TOCTOU hardening. It does not provide new physical WebGPU, real multi-browser relay, real Llama q4 artifact, production deployment, credential, billing, or operator-authorization evidence for #167 or #158.
