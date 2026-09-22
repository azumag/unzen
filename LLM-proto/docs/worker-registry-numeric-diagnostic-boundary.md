# WorkerRegistry numeric diagnostic runtime boundary

Several public `WorkerRegistry` methods accept numeric values from transport/runtime callers even though TypeScript declares them as `number`: absolute timestamps, VRAM requirements, heartbeat timeouts, and busy-state segment indexes. Their validation predicates (`Number.isFinite()` / `Number.isSafeInteger()`) do not coerce objects, but rejection diagnostics must obey the same rule.

The registry therefore formats invalid numeric runtime values through its bounded diagnostic formatter. Primitive values retain useful text such as `NaN`, `Infinity`, `0`, or `-1`. Object and function values are represented by the registry-owned token `unknown`; caller-controlled `Symbol.toPrimitive`, `valueOf`, and `toString` hooks are never invoked. Revoked Proxy objects are likewise rejected without being inspected by diagnostic formatting.

This applies to:

- `register(..., now)` / `heartbeat(..., now)` / `listTimedOut(..., now)` / `revokeGeneration(..., now)` absolute-time validation;
- `getAvailableWorker(requiredVramMB)` VRAM requirement validation;
- `listTimedOut(timeoutMs, ...)` timeout validation;
- `markBusy(..., segmentIndex)` segment-index validation.

Validation order and accepted domains are unchanged. Numeric rejection still occurs before the corresponding repository lookup, worker enumeration, liveness arithmetic, or busy-state mutation. This change only prevents the error-reporting path from executing caller-controlled coercion while preserving useful diagnostics for primitive invalid values.

Related: #103, #167, #1438, #1440.
