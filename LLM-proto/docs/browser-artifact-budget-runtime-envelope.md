# Browser artifact-budget runtime envelope

The real browser split harness treats artifact-budget inputs as runtime data rather than trusting TypeScript or JSON producers. `planSegmentArtifactBudget()` requires a non-array object before it reads segment fields. `verifyActualSegmentArtifactBudget()` requires an object plan and an array of artifact reports before reduction or budget comparisons.

The verifier snapshots and validates the plan byte fields it actually consumes. `declaredBytes`, `requiredMaxBytes`, and `absoluteMaxBytes` must be positive safe integers, the required limit cannot exceed the absolute limit, and declared bytes cannot exceed either runtime limit. Valid plans created by `planSegmentArtifactBudget()` keep the existing P0 (256 MiB) and absolute (1 GiB) behavior.

This contract intentionally does not define behavior for hostile Proxy/getter traps; Issue #634 is limited to top-level container and field-value envelopes. It is reliability hardening for #167 and does not provide new real-model artifact-size, physical WebGPU memory, multi-browser relay/latency, or worker-loss evidence.
