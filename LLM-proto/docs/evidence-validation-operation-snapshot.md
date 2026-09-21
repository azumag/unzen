# Evidence validation-operation snapshot boundary

`validateEvidenceEnvelope()` treats the digest and independent-verification claims that pass synchronous structural validation as the claims for that validation operation.

Before invoking caller-supplied asynchronous callbacks, the validator captures the normalized artifact SHA-256 plus the verification `verifier`, `version`, and `verifiedAt` values into stable plain values. `loadArtifact()` cannot change the expected digest by mutating the original envelope while the validator is awaiting the artifact, and `verifyArtifact()` cannot change the attestation target by mutating the original verification object while the validator is awaiting the independent verifier.

Trusted-verifier policy is evaluated synchronously by `validateCaptured()` before any runtime callback is invoked. The independent attestation must then exactly match the captured verifier/version claim. Because that equality preserves the already-established trust decision, the validator deliberately does not re-read caller-owned `trustedVerifiers` after an awaited callback; doing so would create a second TOCTOU surface without adding a distinct trust guarantee.

This is an operation-scoped decision snapshot, not a deep ownership conversion of the returned envelope. The `envelope` returned in a successful result remains the caller-provided object and can still reflect later caller mutations. Callers that need an immutable archival object must create and own that snapshot separately.

The boundary also does not expand the evidence taxonomy or readiness semantics: digest mismatch, independent-attestation mismatch, callback execution failure, trust validation, and successful-path schema remain unchanged.
