# ArtifactResidencyLedger worker cache inventory runtime envelope

`ArtifactResidencyLedger.synchronizeWorker()` replaces one worker's complete cache-residency snapshot. Heartbeat and cache inventory data can cross runtime/deserialization boundaries, so the public `readonly number[]` TypeScript signature is not treated as sufficient validation.

The method requires a real JavaScript array. It captures the array's initial length, then reads each original position exactly once with indexed access instead of using the caller's `Symbol.iterator`. This fixes the authoritative membership before any element getter executes: if an earlier getter shrinks the caller-owned array, a missing later position is rejected instead of silently disappearing from the inventory.

Every captured value must be a non-negative safe integer and must identify a segment present in the active artifact ledger. Validation does not coerce arbitrary values. The complete captured inventory is validated into a temporary `Set` before `residentByWorker` is changed, so malformed or unknown indexes cannot partially replace a previously valid worker snapshot.

Duplicate indexes continue to collapse to one resident segment. A valid empty array remains the explicit signal to clear the worker's residency. These semantics are unchanged; the change only makes the runtime ownership and atomic replacement boundary explicit and fail-closed.

This is cache-routing reliability hardening in support of #167. It does not constitute new real-model artifact materialization, physical WebGPU memory evidence, multi-browser relay measurements, worker-loss recovery evidence, or a production deployment change.
