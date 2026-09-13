# Durable submission options runtime envelope

`DurableCoordinator.submit(prompt, options)` is an API/transport-facing boundary. The TypeScript options type is compile-time documentation only; decoded or asserted runtime callers can still supply malformed values.

Before reading `idempotencyKey`, `signal`, or `timeoutMs`, the Coordinator therefore requires the supplied options value to be a non-null, non-array object. The omitted/`undefined` call path keeps the existing `{}` default.

Malformed top-level containers such as `null`, primitives, arrays, symbols, and functions fail closed with `UnzenError` / `ErrorCode.ProtocolViolation`. Rejection happens before idempotency lookup or binding, durable request creation, in-flight registration, abort-listener installation, or deadline timer creation.

This boundary is deliberately limited to the top-level options container. Field-level semantics for `prompt`, `signal`, and `timeoutMs` are unchanged. Caller-supplied idempotency keys continue to use the dedicated runtime validation contract and retain exact accepted string identity.

Regression coverage lives in `tests/durable-coordinator-submission-options-envelope.test.ts` and verifies that malformed containers leave both durable request state and coordinator in-flight state untouched.
