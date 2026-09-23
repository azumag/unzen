# Continuous assurance production verifier request JSON input integrity

The production provider-canary and production operations-rollout verifier services accept bounded JSON requests. Those request bytes are part of the verifier protocol boundary and must not be replacement-decoded into a different character sequence before semantic checks.

## Contract

- Both verifier request readers keep the existing 2 MiB byte ceiling.
- Request bytes are decoded as UTF-8 with fatal error handling before `JSON.parse()`.
- Malformed UTF-8 fails before capture or artifact semantic verification.
- Existing `json-body-required` and `body-too-large` behavior is unchanged.
- A valid UTF-8 BOM remains accepted.
- Valid verifier payloads, readiness decisions, artifact checks, and attestation semantics are unchanged.

## Scope

This is request input-integrity hardening only. It does not deploy services, use credentials, call production providers, incur billing, promote readiness, or create new evidence.
