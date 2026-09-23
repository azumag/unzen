# Continuous assurance adapter JSON input integrity

The continuous-assurance provider, evidence, pager, and independent-verifier adapter boundaries treat JSON bodies as bounded UTF-8 input.

## Contract

- Request and upstream response bodies keep the existing byte ceilings before parsing.
- JSON bytes are decoded as UTF-8 with fatal error handling. Malformed UTF-8 is rejected instead of being normalized to U+FFFD before `JSON.parse()`.
- Inbound decode/parse failures continue to map to `json-body-invalid` with HTTP 400.
- Upstream/verifier decode/parse failures continue to map to `upstream-json-body-invalid` with HTTP 502.
- A valid UTF-8 BOM remains accepted.
- Idempotency, retry behavior, provider payload validation, and evidence/readiness semantics are unchanged.

## Scope

This is adapter input-integrity hardening only. It does not add production provider calls, external evidence, readiness promotion, deployment, credentials, billing, or real-model/WebGPU evidence.

Regression coverage lives in `tests/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-adapters.test.ts` and includes malformed inbound JSON, malformed upstream JSON that replacement decoding could otherwise leave syntactically valid, and BOM-compatible valid JSON.
