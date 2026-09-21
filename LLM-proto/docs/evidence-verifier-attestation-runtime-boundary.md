# Evidence verifier attestation runtime boundary

`validateEvidenceEnvelope()` treats the object returned by the caller-supplied `verifyArtifact()` callback as runtime-untrusted even though the TypeScript callback type is `IndependentEvidenceVerification`.

The callback execution and the first reads of `result`, `verifier`, `version`, `verifiedAt`, and `reason` are one fail-closed boundary. A Proxy trap or throwing getter on any of those fields is classified as `verification-execution-failed`, leaves the evidence `not-evaluated`, and must not escape as a runtime exception.

After those field reads complete, validation uses only the captured primitive values. Trust matching, envelope-attestation matching, mismatch reporting, and readiness decisions do not re-read caller-owned attestation getters. A non-string runtime `reason` is not coerced; mismatch reporting falls back to the stable generic attestation-mismatch message.

This hardening does not change the successful attestation schema, trusted-verifier policy, artifact digest contract, evidence level taxonomy, or readiness semantics. It only closes the runtime return-value boundary for an independent verifier callback.
