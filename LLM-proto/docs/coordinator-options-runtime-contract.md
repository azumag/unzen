# Coordinator runtime option contract

`CoordinatorOptions` are a startup trust boundary. Compile-time TypeScript types do not make asserted, decoded, accessor-backed, or proxied JavaScript values safe for heartbeat timers, retry controls, segment-count checks, or the fixture-manifest escape hatch.

The coordinator therefore captures declared runtime options into a new owned envelope and validates it before manifest validation or coordinator-owned worker/checkpoint state is created:

- a supplied options container must be a non-null, non-array object;
- caller-owned options are not spread or enumerated;
- only own-enumerable `heartbeatIntervalMs`, `heartbeatTimeoutMs`, `maxRetries`, `segmentTimeoutMs`, `retryDelayMs`, `totalSegments`, and `allowFixtureManifest` fields are eligible to be read;
- inherited and non-enumerable declared-name properties remain ignored, matching the previous object-spread behavior;
- each accepted declared field value is read at most once, and the same captured value is used for default selection, validation, and retained coordinator state;
- unrelated enumerable getters and Proxy `ownKeys` traps cannot run as option-resolution side effects;
- `heartbeatIntervalMs`, `heartbeatTimeoutMs`, `segmentTimeoutMs`, and `retryDelayMs` must be non-negative finite numbers;
- timer-backed `heartbeatIntervalMs`, `segmentTimeoutMs`, and `retryDelayMs` must also be no greater than `2147483647ms` (`MAX_TIMER_DELAY_MS`), so they cannot overflow browser/Node host timers;
- comparison-only `heartbeatTimeoutMs` is intentionally not constrained to the host-timer range because it is used as an elapsed-time threshold rather than passed to `setTimeout()` or `setInterval()`;
- `maxRetries` must be a non-negative safe integer;
- optional `totalSegments` must be a non-negative safe integer;
- optional `allowFixtureManifest` must be a boolean;
- omitted values keep the existing defaults and explicit zero numeric controls remain valid;
- absent optional fields remain absent from the owned option envelope.

The `allowFixtureManifest` rule is intentionally strict because it is a test-only escape hatch. Truthy non-boolean values such as the string `"false"` must never relax the production-only manifest source check. Only an accepted own-enumerable boolean `true` opts into fixture manifests; omission, inherited/non-enumerable values, or `false` keep the production source gate.

A valid-first/altered-second accessor cannot pass validation and then change the retry, timer, segment-count, or fixture-gate value retained by the coordinator. Likewise, an unrelated getter cannot widen the construction trust boundary merely because it is enumerable. Oversized timer-backed values fail during construction, before heartbeat timer registration, request state, worker selection, or executor work.

This change does not broaden fixture-manifest policy or alter routing, retry, heartbeat timeout comparison, checkpoint, deployment, or billing behavior. It is runtime reliability/trust-boundary hardening related to #167, not new real Llama-3.2-1B q4 materialization, physical WebGPU, multi-browser relay/latency, or worker-loss-resume evidence.
