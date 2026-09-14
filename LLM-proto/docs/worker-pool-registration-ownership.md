# WorkerPool registration ownership

`WorkerPool.register()` is a runtime boundary for legacy browser worker registration. A `WorkerRegistration` TypeScript type does not make a decoded or asserted JavaScript object stable: getters or Proxies can return different values on repeated reads.

## Contract

Registration captures the declared fields in fail-fast order — `workerId`, `tier`, then `vramMB` — and reads each field exactly once. Those captured primitive values are validated and copied into an owned registration snapshot. The same snapshot supplies both the stored `WorkerInfo` and the worker-map key.

This means a caller cannot pass validation with one worker identity, tier, or VRAM value and have a later getter result committed to routing state. Unknown or unrelated properties are not enumerated or read. Invalid earlier fields stop validation before later fields are observed, preserving the existing fail-fast boundary.

Valid registration and same-ID replacement behavior are unchanged.

## Evidence boundary

This is an in-process legacy routing ownership guarantee. It does not establish real browser capability measurements, physical WebGPU behavior, multi-browser continuation, relay latency, or worker-loss recovery evidence for #167, and it does not change #158 production deployment, credentials, billing, or HOLD status.
