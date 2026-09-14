# Browser artifact-budget runtime envelope

The real browser split harness treats artifact-budget inputs as runtime data rather than trusting TypeScript or JSON producers. `planSegmentArtifactBudget()` requires a non-array object before it reads segment fields. `verifyActualSegmentArtifactBudget()` requires an object plan and an array of artifact reports before reduction or budget comparisons.

The verifier now takes an owned shallow snapshot of the caller-provided plan before validating or constructing an accepted result. This is important for accessor- or Proxy-backed plans: `declaredBytes`, `requiredMaxBytes`, and `absoluteMaxBytes` must not be read once for validation and then read again with different values while the result is assembled. The captured values are used for both validation and the returned report, so an accepted report describes the same budget state that was actually checked.

The consumed byte fields must be positive safe integers, the required limit cannot exceed the absolute limit, and declared bytes cannot exceed either runtime limit. Valid plans created by `planSegmentArtifactBudget()` keep the existing P0 (256 MiB) and absolute (1 GiB) behavior. Extra enumerable plan metadata is preserved in the owned shallow snapshot without re-reading the caller-owned object during result construction.

This contract does not promise recovery from arbitrary throwing Proxy traps during snapshot capture; those failures still fail closed. Issue #662 specifically removes repeated caller-owned plan reads across validation/result construction. It is reliability hardening for #167 and does not provide new real-model artifact-size, physical WebGPU memory, multi-browser relay/latency, or worker-loss evidence.
