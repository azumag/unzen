# Worker revocation runtime envelope

`WorkerRegistry.revokeGeneration(workerId, generation)` mutates worker lifecycle state and the revoked-generation archive. Its branded TypeScript identifiers are compile-time documentation only; decoded or asserted runtime values must be treated as untrusted.

Before repository lookup, active-worker mutation/deletion, or revoked-generation archive mutation, the registry requires both `workerId` and `generation` to be non-empty runtime strings. `null`, `undefined`, numbers, booleans, arrays, objects, symbols, and empty/whitespace-only strings fail closed with `UnzenError` / `ErrorCode.ProtocolViolation`.

For valid identities, the existing semantics are unchanged:

- revoking the current generation marks it revoked, archives a detached snapshot, and removes it from the active worker set;
- revoking a valid stale/unknown generation records a revoked archival entry for late-delivery tracing without replacing the current active worker;
- reconnect generation issuance and lease-reclaim policy remain owned by their existing coordinator paths.

Regression coverage lives in `tests/worker-registry-runtime-boundary.test.ts` and proves malformed identities do not alter the active worker or current-generation lookup state while the valid current/stale revocation behaviors are preserved.