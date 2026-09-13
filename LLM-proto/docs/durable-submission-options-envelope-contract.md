# Durable submission options runtime envelope

`DurableCoordinator.submit(prompt, options)` is an API/transport-facing boundary. The TypeScript options type is compile-time documentation only; decoded or asserted runtime callers can still supply malformed values.

Before reading `idempotencyKey`, `signal`, or `timeoutMs`, the Coordinator requires the supplied options value to be a non-null, non-array object. The omitted/`undefined` call path keeps the existing `{}` default. It then validates the optional `signal` and `timeoutMs` fields before idempotency lookup or binding, durable request creation, in-flight registration, abort-listener installation, or deadline timer creation.

Malformed top-level containers such as `null`, primitives, arrays, symbols, and functions fail closed with `UnzenError` / `ErrorCode.ProtocolViolation`. The same failure mode applies to malformed field values, so the boundary never relies on incidental property/method failures or `setTimeout()` coercion after durable state has already been created.

## `timeoutMs`

When present, `timeoutMs` must be a non-negative finite JavaScript number. Strings, booleans, objects, symbols, `NaN`, infinities, and negative numbers are rejected before any durable or idempotency mutation.

`timeoutMs = 0` remains supported and preserves the existing immediate-deadline behavior. This hardening intentionally does not introduce a new positive-only minimum or a new maximum deadline; those would be public behavior changes outside this issue. Fractional finite non-negative values likewise retain the platform timer semantics that existed before this boundary was added.

## `signal`

When present, `signal` is checked structurally rather than with `instanceof AbortSignal`, because valid signals may originate in another browser realm. The runtime contract requires a non-null, non-array object exposing:

- boolean `aborted`;
- callable `addEventListener`;
- callable `removeEventListener`.

This is an interface-shape gate, not an identity check. A structurally compatible cross-realm signal therefore remains accepted, while malformed values fail before listener installation or durable mutation.

Caller-supplied idempotency keys continue to use their dedicated runtime validation contract and retain exact accepted string identity. `prompt` validation remains a separate concern and is not changed by this contract.

Regression coverage lives in `tests/durable-coordinator-submission-options-envelope.test.ts`. It verifies malformed top-level containers and field values leave idempotency state, durable request state, and coordinator in-flight state untouched; it also verifies a structurally compatible signal is accepted and `timeoutMs = 0` is retained on the durable request record.
