# AdaptiveChunkDispatcher remaining constructor option runtime boundary

`AdaptiveChunkDispatcher` accepts runtime-originated option objects that can be asserted, proxied, or accessor-backed. The constructor therefore treats the remaining non-numeric option properties as runtime reads rather than assuming their TypeScript surface is trustworthy.

The following fields are captured exactly once after segment and numeric-option validation:

- `coordinatorUrl`
- `cdnUrl`
- `artifactResidencyLedger`
- `transport`

If a getter or Proxy trap for one of these fields throws, the dispatcher replaces that failure with a stable field-specific `AdaptiveChunkDispatcher ... could not be read` diagnostic. The thrown value is never inspected, stringified, or coerced, so caller-controlled `Symbol.toPrimitive`, `valueOf`, and `toString` hooks are not executed by this boundary.

Successfully-read values retain the previous semantics. `undefined`/nullish URL and transport values still select the existing defaults, an explicitly supplied transport still performs its existing allowlist checks, and an explicitly supplied artifact residency ledger still performs the existing segment-compatibility check. Segment validation, numeric-option validation, routing/scoring behavior, cache residency behavior, and transport/ledger downstream validation order are unchanged.

This is runtime reliability hardening only. It is not new real-model, physical WebGPU, distinct-browser relay/latency, worker-loss/resume, or artifact-residency execution evidence for #167.
