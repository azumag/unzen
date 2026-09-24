# Browser artifact-budget cumulative byte arithmetic

`verifyActualSegmentArtifactBudget()` treats measured artifact byte counts as an exact runtime contract. Each `reports[].bytes` value must be a non-negative JavaScript safe integer, and the verifier also requires the cumulative sum to remain a safe integer after every addition.

This cumulative check happens before manifest-equality and browser-budget comparisons. A caller therefore cannot force the verifier to continue with an imprecise IEEE-754 total by supplying individually valid but cumulatively overflowing byte counts such as `[Number.MAX_SAFE_INTEGER, 1]`.

Normal browser artifacts remain governed by the existing P0 and absolute limits: accepted totals must exactly equal the manifest-declared artifact size, remain within the selected runtime budget, and preserve the existing result shape. The cumulative-overflow guard is input-integrity hardening only; it does not change artifact planning policy or constitute new real-model, physical WebGPU, relay/latency, cache-residency, or worker-loss evidence for #167.
