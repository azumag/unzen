# Evidence root discriminant snapshot

`validateEvidenceEnvelope()` treats the caller-owned envelope as a runtime trust boundary. After the top-level record check, the validator reads `schemaVersion`, `evidenceLevel`, and `readinessStatus` exactly once and keeps those primitive values for the rest of that validation attempt.

This prevents accessor-backed or Proxy-backed envelopes from returning one valid value during a type/classification check and a different value when the validator later selects an evidence branch, checks readiness, or compares schema support. In particular:

- the captured `evidenceLevel` is used for validation and branch selection;
- the captured `readinessStatus` is used for readiness-limit checks and the returned claimed/effective status;
- the captured `schemaVersion` is used for both the required-string check and supported-schema lookup.

The boundary is intentionally narrow. It is not a deep freeze of the entire evidence envelope, and it does not eagerly inspect nested `artifact`, `verification`, payload, or callback fields. Existing validation for those fields remains at its current validation stage, including the separate operation-scoped snapshots used around asynchronous artifact loading and independent verification.

This rule is a runtime consistency guarantee, not additional evidence. It does not upgrade readiness or provide new model, WebGPU, relay, failover, or residency measurements.
