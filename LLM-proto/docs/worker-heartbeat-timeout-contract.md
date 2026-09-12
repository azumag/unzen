# Worker heartbeat timeout contract

`WorkerPool.getTimedOutWorkers()` and `WorkerRegistry.listTimedOut()` are coordinator-side liveness decision boundaries. Their `timeoutMs` argument must be a positive finite number before any worker state is inspected.

`0`, negative values, `NaN`, `Infinity`, and `-Infinity` are rejected. This is fail-closed behavior rather than silently changing liveness semantics:

- `elapsed > NaN` is always false in JavaScript, so `NaN` would disable timeout detection;
- a negative timeout makes every worker with a non-negative elapsed time immediately eligible as timed out;
- infinite values do not represent a bounded heartbeat window.

For a valid timeout, existing semantics are unchanged: a worker is timed out only when elapsed time is strictly greater than `timeoutMs`, and the existing disconnected/revoked exclusions continue to apply in their respective legacy and durable implementations.

The legacy in-memory `WorkerPool` and durable `WorkerRegistry` intentionally enforce the same numeric boundary so malformed runtime configuration cannot make the two coordinator paths disagree.

This contract is coordinator-side liveness hardening only. It does not demonstrate physical worker loss, real browser/WebGPU cancellation, lease recovery under an actual process failure, or the real 1B multi-browser relay/resume path tracked by #167.
