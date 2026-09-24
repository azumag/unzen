# Browser artifact-budget cumulative byte arithmetic

Browser artifact byte accounting is an exact runtime contract at both planning and verification boundaries. `planSegmentArtifactBudget()` requires every `externalData[].bytes` value to be a non-negative JavaScript safe integer and rejects the input before any addition that would make the cumulative external-data total leave the safe-integer range. It therefore derives `graphDeclaredBytes` only from an exactly representable external-data total.

`verifyActualSegmentArtifactBudget()` first validates the caller-owned plan snapshot. Both `graphDeclaredBytes` and `externalDeclaredBytes` must be safe integers, and their recomposition is rejected before addition if it would leave the safe-integer range. Ordinary exact-but-inconsistent breakdowns retain the same `graph/external byte breakdown must equal declaredBytes` failure contract.

The verifier applies the same exact-arithmetic rule to measured artifact reports. Each `reports[].bytes` value must be a non-negative safe integer, and the cumulative report total must remain a safe integer before every addition.

These checks happen before graph-byte derivation, manifest-equality, and browser-budget comparisons. A caller therefore cannot force planning, direct-plan verification, or measured-report verification to continue with an imprecise IEEE-754 total by supplying individually valid but cumulatively overflowing byte counts such as `[Number.MAX_SAFE_INTEGER, 1]`.

Normal browser artifacts remain governed by the existing P0 and absolute limits: accepted totals must exactly equal the manifest-declared artifact size, remain within the selected runtime budget, and preserve the existing planner/verifier result shapes. The exact-arithmetic guards are input-integrity hardening only; they do not change artifact planning policy or constitute new real-model, physical WebGPU, relay/latency, cache-residency, or worker-loss evidence for #167.
