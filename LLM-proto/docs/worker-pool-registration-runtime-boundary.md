# WorkerPool registration runtime boundary

`WorkerPool.register()` consumes legacy wire-protocol data. TypeScript types do not make those runtime values trustworthy, so registration validation owns the boundary before any worker can enter routing state.

The registration root must be a non-null, non-array object. Array classification is guarded because `Array.isArray()` throws for a revoked Proxy; revoked containers therefore fail through the same stable `worker registration must be a non-null object` validation bucket as other invalid containers.

Declared fields are read exactly once and in fail-fast order: `workerId`, then `tier`, then `vramMB`. If a getter or Proxy trap throws, validation emits a stable field-specific diagnostic and does not inspect, stringify, or otherwise coerce the thrown value. Later fields are not read after an earlier failure, and the pool remains unchanged until all three captured values have passed validation.

Invalid primitive tier/VRAM values keep useful diagnostics such as `found 99` or `found NaN`. Object and function values are reported as `unknown` rather than passed to `String(...)`, so caller-owned `Symbol.toPrimitive`, `valueOf`, and `toString` hooks cannot run while the validation error is being constructed.

This does not change worker tier ordering, VRAM routing semantics, heartbeat/liveness behavior, live WorkerInfo views, or protocol shape. It is reliability/trust-boundary hardening only and is not new real-model, physical WebGPU, distinct-browser relay/latency, worker-loss/resume, or artifact-residency evidence for #167.

Focused regressions live in `tests/worker-pool-registration-runtime-boundary.test.ts`; the existing registration-container and owned-snapshot tests continue to pin the historical validation and single-read behavior.
