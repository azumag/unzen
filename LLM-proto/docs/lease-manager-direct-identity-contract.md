# LeaseManager direct runtime identity contract

`LeaseManager` sits directly above the durable lease repository. Branded TypeScript IDs therefore do not by themselves establish that decoded or asserted runtime values are safe repository keys.

The direct request lookup/reclaim methods `getActive()`, `isActive()`, and `reclaimByRequest()` require `requestId` to be a non-empty runtime string before `getActiveLease()` is called. Malformed values fail closed with `UnzenError` / `ErrorCode.ProtocolViolation` and cannot trigger a lease lookup or deletion.

`reclaimByWorkerGeneration()` applies the same boundary before active-lease enumeration: both `workerId` and `generation` must be non-empty runtime strings. Malformed values cannot call `listActiveLeases()` or delete leases.

`match()` and `reclaim(identity, now)` additionally treat the full caller-supplied `ResultIdentity` as a runtime trust boundary. `requestId`, `attemptId`, `leaseId`, `workerId`, `workerGeneration`, and `segmentIndex` are read once in validation order and copied into an owned identity snapshot before repository access. Lease lookup and every mismatch comparison use only that snapshot. `reclaim()` also deletes exactly the captured `leaseId`; it never re-reads a caller accessor after a successful match. This prevents accessors or Proxies from validating one lease identity and then drifting the repository lookup, comparison, or deletion target.

Valid semantics are unchanged:

- an unknown request resolves to `undefined` / `false`, and reclaim is a no-op;
- a known request resolves to its active lease and can be reclaimed normally;
- an unknown but valid worker/generation pair reclaims nothing;
- the matching worker generation still reclaims all of its active leases;
- `match()` preserves the existing mismatch reasons and expiry behavior;
- `reclaim(identity, now)` remains compare-and-delete, but the comparison and deletion are now bound to one owned identity snapshot.

Focused coverage is in `tests/lease-manager-runtime-boundary.test.ts`. Repository counters prove malformed direct identities cause zero lease reads/listings/deletes, while accessor regressions prove every result-identity field is read once and a mutable `leaseId` cannot redirect a successful reclaim to another lease.

This work is runtime reliability/trust-boundary hardening only. It is not real Llama-3.2-1B q4 artifact materialization, physical WebGPU/GPU-memory evidence, real multi-browser checkpoint relay, worker-loss resume, or production deployment evidence for #167/#158.
