# Identifier runtime contract

Tracking: #519. Parent technical-core work: #167.

`WorkerId` and `InferenceRequestId` are branded strings at compile time, but coordinator and browser-facing code can still receive decoded, asserted, or otherwise untyped runtime values. Branding therefore happens only after a runtime string check.

Contract:

- The runtime value must be an actual JavaScript string.
- Empty and whitespace-only strings are rejected.
- A valid non-empty string is preserved exactly; no trimming or normalization changes identity.
- Objects that merely expose a `trim()` method are rejected rather than accepted as branded identifiers.
- Primitive, array, object, `null`, `undefined`, and `Symbol` values are rejected before entering routing maps or request state.

This is coordinator-side contract evidence only. It does not count as real multi-browser WebGPU, checkpoint-relay, worker-loss-resume, or production deployment evidence for #167/#158.
