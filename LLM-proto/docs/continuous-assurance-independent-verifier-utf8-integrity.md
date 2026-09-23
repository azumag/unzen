# Continuous-assurance independent-verifier UTF-8 integrity

The independent verifier treats JSON byte streams as strict UTF-8 at both externally supplied JSON boundaries it parses itself:

- bounded request bodies for `/verify/capture` and `/verify/artifact`;
- digest-matching production-deployment-canary artifact bytes before artifact JSON binding checks.

Decoding uses fatal UTF-8 semantics before `JSON.parse()`. Malformed byte sequences therefore cannot be normalized to U+FFFD and then accepted as otherwise-valid JSON. Existing byte ceilings, SHA-256 binding, schema checks, readiness checks, HTTP statuses, and public error strings remain unchanged.

This change is input-integrity hardening only. It does not authenticate the producer, alter evidence schemas or readiness levels, deploy production Workers, or count as new production/readiness evidence. The provider/evidence/pager adapter JSON readers are a separate follow-up boundary and are intentionally not changed here.
