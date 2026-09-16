# Durable submission options runtime envelope

`DurableCoordinator.submit(prompt, options)` is an API/transport-facing boundary. The TypeScript options type is compile-time documentation only; decoded or asserted runtime callers can still supply malformed values.

Before reading `idempotencyKey`, `signal`, or `timeoutMs`, the Coordinator requires the supplied options value to be a non-null, non-array object. The omitted/`undefined` call path keeps the existing `{}` default. It then validates the optional `signal` and `timeoutMs` fields before idempotency lookup or binding, durable request creation, in-flight registration, abort-listener installation, or deadline timer creation.

Malformed top-level containers such as `null`, primitives, arrays, symbols, and functions fail closed with `UnzenError` / `ErrorCode.ProtocolViolation`. The same failure mode applies to malformed field values, so the boundary never relies on incidental property/method failures or `setTimeout()` coercion after durable state has already been created.

## `timeoutMs`

When present, `timeoutMs` must be a non-negative finite JavaScript number no greater than `2147483647ms` (`MAX_TIMER_DELAY_MS`). Strings, booleans, objects, symbols, `NaN`, infinities, negative numbers, and larger finite values are rejected before any durable/idempotency mutation or deadline timer registration.

`timeoutMs = 0` remains supported and preserves the existing immediate-deadline behavior. All previously representable positive values, including the exact host-timer maximum, remain accepted. Fractional finite non-negative values within the host range likewise retain the platform timer semantics that existed before this boundary was added.

## `signal`

When present, `signal` is checked structurally rather than with `instanceof AbortSignal`, because valid signals may originate in another browser realm. The runtime contract requires a non-null, non-array object exposing:

- boolean `aborted`;
- callable `addEventListener`;
- callable `removeEventListener`.

This is an interface-shape gate, not an identity check. A structurally compatible cross-realm signal therefore remains accepted, while malformed values fail before listener installation or durable mutation.

Caller-supplied idempotency keys continue to use their dedicated runtime validation contract and retain exact accepted string identity. `prompt` validation remains a separate concern and is not changed by this contract.

Regression coverage lives in `tests/durable-coordinator-submission-options-envelope.test.ts` and `tests/durable-host-timer-range-options.test.ts`. It verifies malformed and host-timer-overflowing values leave idempotency state, durable request state, coordinator in-flight state, and host timers untouched; it also verifies a structurally compatible signal is accepted and `timeoutMs = 0` remains valid.
