# Durable submission option ownership contract

`DurableCoordinator.submit()` snapshots its caller-owned top-level options before the durable core validates or acts on them.

## Top-level snapshot

The public boundary reads `idempotencyKey`, `signal`, and `timeoutMs` exactly once and passes a fresh plain object into the existing durable submit implementation. The core remains authoritative for protocol validation, idempotency binding, durable request creation, listener installation, deadline setup, cancellation, and recovery behavior.

Submission options historically use ordinary JavaScript property lookup rather than object-spread membership. Inherited and non-enumerable declared fields therefore remain visible; this hardening changes read ownership without changing that property lookup policy.

Malformed option containers (null, arrays, primitives, functions) fail with the existing `protocol-violation` semantics before a durable request is created.

## AbortSignal remains live

Only the top-level `signal` reference is captured. The `AbortSignal` object itself is intentionally not frozen or converted into a static snapshot: a controller must still be able to abort it after `submit()` returns. Existing core validation continues to require an AbortSignal-compatible object before listener installation.

This contract prevents a top-level accessor from returning a valid signal/timeout/idempotency key during validation and a different value during durable mutation or timer/listener setup, while preserving live cancellation semantics.

## Evidence boundary

This is runtime ownership / TOCTOU hardening. It does not provide new physical WebGPU, real multi-browser relay, real Llama q4 artifact, production deployment, credential, billing, or operator-authorization evidence for #167 or #158.
