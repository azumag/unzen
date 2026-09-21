# Evidence callback error-format runtime boundary

`validateEvidenceEnvelope()` treats values thrown by caller-supplied `loadArtifact()` and `verifyArtifact()` callbacks as runtime-untrusted. The failure path must remain fail-closed even when the thrown value itself is hostile to JavaScript inspection.

Error formatting therefore guards `instanceof Error`, `Error.message` access, and generic `String(...)` conversion as one bounded operation. Normal `Error` messages and ordinary thrown primitives retain their useful text when inspection succeeds. If a Proxy trap, getter, `toString()`, `Symbol.toPrimitive`, or another conversion hook throws while formatting the original failure, the validator uses the stable fallback text `uninspectable thrown value` instead of allowing a secondary exception to escape.

This boundary does not change evidence status or issue taxonomy. Artifact-loader failures remain `artifact-load-failed` / `not-evaluated`; independent-verifier execution failures remain `verification-execution-failed` / `not-evaluated`. Successful validation, digest checks, verifier trust, attestation matching, and readiness semantics are unchanged.
