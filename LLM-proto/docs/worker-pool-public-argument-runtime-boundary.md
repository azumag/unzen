# WorkerPool public numeric argument runtime boundary

`WorkerPool` is callable from JavaScript even though its public API is typed. The numeric arguments accepted by `getAvailableWorker(requiredVramMB)`, `getTimedOutWorkers(timeoutMs)`, and `markBusy(id, segmentIndex)` therefore remain runtime trust boundaries.

The validators reject invalid values before worker selection, timeout scanning, or busy-state mutation. Diagnostic formatting uses the same bounded runtime-value formatter as registration validation: primitive values retain useful text (`NaN`, `0`, `-1`, and similar), while object and function values are reported as `unknown` without invoking caller-owned `Symbol.toPrimitive`, `valueOf`, or `toString` hooks.

This does not change VRAM selection, heartbeat timeout arithmetic, worker lookup, status transitions, or segment-index semantics. It only ensures an invalid runtime value cannot replace the intended WorkerPool validation error while that error is being constructed.

Focused regressions live in `tests/worker-pool-public-argument-runtime-boundary.test.ts` and verify all three public methods, coercion-hook non-execution, and zero routing/liveness/busy-state mutation on failure.

This is runtime reliability hardening only and is not new real-model, physical WebGPU, distinct-browser relay/latency, worker-loss/resume, or artifact-residency evidence for #167.
