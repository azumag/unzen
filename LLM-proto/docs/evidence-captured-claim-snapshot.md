# Captured evidence claim snapshot

For `captured-and-verified` evidence, `validateEvidenceEnvelope()` treats the nested artifact and verification claims that drive later external checks as caller-owned runtime input.

During structural validation, the validator obtains the top-level `artifact` and `verification` records through the bounded runtime property-read helper, then captures the artifact locator, SHA-256 digest, expiry timestamp, verifier name/version, verification timestamp, and verification result through the same bounded read boundary. A throwing accessor or hostile Proxy is therefore treated like missing/invalid captured metadata and is mapped into the existing validation issue taxonomy instead of escaping the validator. The thrown value itself is not inspected or stringified.

The captured claim fields are operation-local primitive values. The same captured digest is used for digest syntax validation and for comparison with the loaded artifact. The same captured verifier name/version and verification timestamp are used for trust validation and for matching the independent verifier attestation. The captured artifact locator is also reused for the loader call rather than rereading the caller-owned object after validation.

This prevents accessor-backed or Proxy-backed nested claims from either throwing through the validation boundary or validating one value and then returning another value later in the same validation attempt. It complements the root-discriminant snapshot and the existing snapshots around awaited callbacks; it is not a deep freeze of the envelope. Other nested fields continue to be validated at their existing stages, and external artifact loading and independent verification remain lazy.

This is runtime consistency hardening only. It does not increase evidence readiness or provide new model, WebGPU, relay, failover, or residency measurements.
