# LeaseManager direct runtime identity contract

`LeaseManager` sits directly above the durable lease repository. Branded TypeScript IDs therefore do not by themselves establish that decoded or asserted runtime values are safe repository keys.

The direct request lookup/reclaim methods `getActive()`, `isActive()`, and `reclaimByRequest()` require `requestId` to be a non-empty runtime string before `getActiveLease()` is called. Malformed values fail closed with `UnzenError` / `ErrorCode.ProtocolViolation` and cannot trigger a lease lookup or deletion.

`reclaimByWorkerGeneration()` applies the same boundary before active-lease enumeration: both `workerId` and `generation` must be non-empty runtime strings. Malformed values cannot call `listActiveLeases()` or delete leases.

Valid semantics are unchanged:

- an unknown request resolves to `undefined` / `false`, and reclaim is a no-op;
- a known request resolves to its active lease and can be reclaimed normally;
- an unknown but valid worker/generation pair reclaims nothing;
- the matching worker generation still reclaims all of its active leases.

Focused coverage is in `tests/lease-manager-runtime-boundary.test.ts`, with repository counters proving malformed direct identities cause zero lease reads/listings/deletes.

`issue()`, `setActive()`, `match()`, and `reclaim(identity, now)` are intentionally outside this contract and can be hardened separately without changing this issue's direct lookup/reclaim semantics.

This work is runtime reliability/trust-boundary hardening only. It is not real Llama-3.2-1B q4 artifact materialization, physical WebGPU/GPU-memory evidence, real multi-browser checkpoint relay, worker-loss resume, or production deployment evidence for #167/#158.