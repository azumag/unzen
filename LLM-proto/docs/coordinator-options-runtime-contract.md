# Coordinator runtime option contract

`CoordinatorOptions` are a startup trust boundary. Compile-time TypeScript types do not make asserted or decoded JavaScript values safe for heartbeat timers, retry controls, segment-count checks, or the fixture-manifest escape hatch.

The coordinator therefore validates options before manifest validation or coordinator-owned worker/checkpoint state is created:

- a supplied options container must be a non-null, non-array object;
- `heartbeatIntervalMs`, `heartbeatTimeoutMs`, `segmentTimeoutMs`, and `retryDelayMs` must be non-negative finite numbers;
- `maxRetries` must be a non-negative safe integer;
- optional `totalSegments` must be a non-negative safe integer;
- optional `allowFixtureManifest` must be a boolean;
- omitted values keep the existing defaults and explicit zero numeric controls remain valid.

The `allowFixtureManifest` rule is intentionally strict because it is a test-only escape hatch. Truthy non-boolean values such as the string `"false"` must never relax the production-only manifest source check. Only the explicit boolean `true` opts into fixture manifests; omission or `false` keeps the production source gate.

This change does not broaden fixture-manifest policy or alter routing, retry, heartbeat, checkpoint, deployment, or billing behavior. It is runtime reliability/trust-boundary hardening related to #167, not new real Llama-3.2-1B q4 materialization, physical WebGPU, multi-browser relay/latency, or worker-loss-resume evidence.
