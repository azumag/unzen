# AdaptiveChunkDispatcher numeric option runtime boundary

`AdaptiveChunkDispatcher` may receive asserted, deserialized, accessor-backed, or proxied option objects at runtime. The numeric constructor options therefore use the same bounded read discipline as the segment envelope.

The following fields are captured exactly once before their existing validation/defaulting logic runs:

- `loadBudgetRatio`
- `longLivedWorkerMs`
- `configuredVramLimitMB`
- `checkpointBytes`

If a getter or Proxy trap for one of these fields throws, the dispatcher converts that failure to a stable field-specific `... could not be read` diagnostic. It does not inspect, stringify, or coerce the thrown value, so caller-controlled `Symbol.toPrimitive`, `valueOf`, and `toString` hooks are not executed by this boundary.

Valid explicit values, omitted values, defaults, and the existing numeric acceptance/rejection rules are unchanged. Segment validation still happens first, and URL, transport, artifact-ledger, routing, scoring, deployment, and evidence semantics are outside this change.

This is runtime reliability hardening only and is not new real-model, physical WebGPU, multi-browser relay/latency, worker-loss/resume, or artifact-residency evidence.
