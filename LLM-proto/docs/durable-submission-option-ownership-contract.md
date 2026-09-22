# Durable submission option ownership contract

`DurableCoordinator.submit()` snapshots its caller-owned top-level options before the durable core validates or acts on them.

## Top-level snapshot

The public boundary reads `idempotencyKey`, `signal`, and `timeoutMs` exactly once and passes a fresh plain object into the existing durable submit implementation. The core remains authoritative for protocol validation, idempotency binding, durable request creation, listener installation, deadline setup, cancellation, and recovery behavior.

Submission options historically use ordinary JavaScript property lookup rather than object-spread membership. Inherited and non-enumerable declared fields therefore remain visible; this hardening changes read ownership without changing that property lookup policy.

Malformed option containers (null, arrays, primitives, functions) fail with the existing `protocol-violation` semantics before a durable request is created. If a declared top-level option getter or Proxy `get` trap throws, the public boundary converts that inaccessible field into a stable `protocol-violation` diagnostic (`submission option <field> could not be read`). The caller-thrown value is treated as opaque: it is never stringified, inspected, or coerced, and rejection happens before idempotency binding or durable request mutation.

## AbortSignal remains live

Only the top-level `signal` reference is captured. The `AbortSignal` object itself is intentionally not frozen or converted into a static snapshot: a controller must still be able to abort it after `submit()` returns. Existing core validation continues to require an AbortSignal-compatible object before listener installation.

The initial signal surface (`aborted`, `addEventListener`, and `removeEventListener`) is also captured through a bounded runtime boundary before any caller listener can be installed. A throwing accessor or Proxy trap is normalized to the existing `submission signal must expose boolean aborted and event-listener methods` protocol diagnostic, without coercing the thrown value. This keeps inaccessible signal surfaces from leaking native/caller exceptions or creating partial listener/durable state.

The durable core treats listener installation as a race-sensitive boundary: it checks `signal.aborted`, installs the one-shot abort listener when still live, and then checks `signal.aborted` again. Native `AbortSignal` does not replay an abort event that was already dispatched before a late listener became active, so the post-subscription check closes that check-then-listen window. Terminal cleanup removes the listener idempotently whether cancellation, completion, failure, or timeout settles the request.

This contract prevents a top-level accessor from returning a valid signal/timeout/idempotency key during validation and a different value during durable mutation or timer/listener setup, while preserving live cancellation semantics.

## Evidence boundary

This is runtime ownership / TOCTOU hardening. It does not provide new physical WebGPU, real multi-browser relay, real Llama q4 artifact, production deployment, credential, billing, or operator-authorization evidence for #167 or #158.
