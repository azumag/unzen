# Caller idempotency-key runtime contract

`idempotencyKey()` is the branding boundary used by `DurableCoordinator.submit()` before caller-provided idempotency identity reaches durable lookup/binding. TypeScript's `string` annotation does not validate decoded or asserted runtime input, so the helper rejects malformed values before branding them.

Accepted values are actual non-empty strings. Whitespace is used only to determine whether a key is empty: an otherwise non-empty accepted key is returned byte-for-byte as supplied and is not trimmed or canonicalized, preserving existing idempotency identity semantics.

`null`, `undefined`, non-string primitives, arrays/objects, `Symbol`, empty strings, and whitespace-only strings fail closed before they can become durable idempotency keys.

This change does not alter repository CAS/deduplication, recovery, sharding, production deployment, credentials, or billing. It is API/runtime identity hardening only and is not real 1B WebGPU, physical GPU working-set, multi-browser relay, or worker-loss-resume evidence for #167.
