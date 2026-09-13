# WorkerPool registration container contract

Tracking: #533. Parent technical-core work: #167.

The legacy `WorkerPool.register()` remains a coordinator-side runtime trust boundary for registration data that may originate from decoded or asserted wire-protocol values. TypeScript's `WorkerRegistration` type does not make the runtime container valid.

Before reading `workerId`, `tier`, or `vramMB`, the pool requires the registration value to be a non-null, non-array JavaScript object. Values such as `null`, numbers, strings, arrays, and symbols therefore fail through an intentional registration validation error instead of incidental property access behavior.

After the container check, the existing field contract is unchanged:

- `workerId` must be a non-empty string;
- `tier` must be Tier 1, 2, or 3;
- `vramMB` must be positive and finite.

All validation completes before the worker map is changed, so a rejected registration cannot create a worker or replace an existing last-known-good registration.

This is coordinator runtime-contract evidence only. It does not count as real browser WebGPU, physical GPU working-set, multi-browser checkpoint relay, worker-loss resume, or production deployment evidence for #167/#158.
