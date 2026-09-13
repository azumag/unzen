# LeaseManager result identity runtime envelope

`LeaseManager.match()` and `reclaim(identity, now)` are durable lease-fencing boundaries. Their TypeScript types are not sufficient protection when a caller passes decoded or asserted runtime values, so the manager validates the complete identity before reading the active lease.

Before `getActiveLease()` is called, the result identity must be a non-null, non-array object whose:

- `requestId`, `attemptId`, `leaseId`, `workerId`, and `workerGeneration` are non-empty runtime strings;
- `segmentIndex` is a non-negative safe integer.

The match clock `now` must also be a finite runtime number before expiry comparison. Malformed values fail closed with `UnzenError` / `ErrorCode.ProtocolViolation`. `reclaim(identity, now)` inherits the same validation through `match()` and cannot delete a lease if validation fails.

Valid fencing semantics are unchanged: exact identities match, expired leases return `lease-expired`, each identity mismatch keeps its existing reason, missing leases return `no-active-lease`, and compare-and-delete reclaim deletes only after an exact live match.

Focused coverage is in `tests/lease-manager-result-envelope.test.ts`, with repository counters proving malformed identities and clocks cause zero active-lease reads and zero lease deletions. Existing `lease-manager.test.ts` continues to exercise all mismatch reasons.

This is runtime protocol hardening only. It is not real Llama-3.2-1B q4 artifact materialization, physical WebGPU/GPU-memory evidence, real multi-browser checkpoint relay, worker-loss resume, or production deployment evidence for #167/#158.