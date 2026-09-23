# Continuous assurance verifier artifact JSON input integrity

Production evidence verifiers bind their decisions to exact artifact bytes. A digest match alone is not sufficient if malformed UTF-8 can be replacement-decoded into a different JSON character sequence before semantic validation.

## Contract

- Deployment-canary, provider-canary, and production-rollout artifact JSON is decoded as UTF-8 with fatal error handling before `JSON.parse()`.
- Digest verification remains ahead of artifact JSON interpretation.
- Malformed provider-canary artifact JSON keeps the existing `provider-canary-artifact-json-invalid` failure reason.
- Malformed production-rollout artifact JSON keeps the existing `production-rollout-artifact-json-invalid` failure reason.
- A valid UTF-8 BOM remains accepted.
- Valid artifact schemas, envelope bindings, readiness decisions, and attestation checks are unchanged.

The deployment-canary artifact reader already had this fatal UTF-8 behavior when this hardening was applied; the change closes the same boundary for the two remaining production verifier artifact readers.

## Scope

This is verifier artifact input-integrity hardening only. Request-body JSON decoding is a separate protocol boundary. This change does not deploy production services, use credentials, make provider calls, incur billing, promote readiness, or create new evidence.
