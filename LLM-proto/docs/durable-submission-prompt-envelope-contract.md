# Durable submission prompt runtime boundary

`DurableCoordinator.submit(prompt, options)` is an API/transport-facing boundary. The TypeScript `string` annotation on `prompt` is compile-time documentation only; decoded or asserted runtime callers can still supply non-string values.

Before options validation, idempotency lookup or binding, request-ID generation, durable request creation, in-flight registration, abort-listener installation, or deadline timer creation, the Coordinator requires `prompt` to be a JavaScript string. Any non-string value fails closed with `UnzenError` / `ErrorCode.ProtocolViolation` and the message `submission prompt must be a string`.

This hardening deliberately preserves the existing accepted string domain exactly. Empty strings, whitespace-only strings, newline-only strings, and other string values remain accepted without trimming, normalization, length limits, or content policy changes. Those would be separate product/API decisions rather than runtime type validation.

Malformed prompts therefore cannot bind an idempotency key, create durable request state, or create a local in-flight entry. The dedicated options, `signal`, `timeoutMs`, and idempotency-key runtime contracts remain unchanged and execute only after the prompt has passed this boundary.

Regression coverage lives in `tests/durable-coordinator-submission-prompt-envelope.test.ts`. It covers `null`, `undefined`, numbers, booleans, arrays, objects, symbols, and functions, and verifies that idempotency mappings, durable requests, and coordinator in-flight state remain untouched. It also confirms that valid string values are persisted byte-for-byte as supplied.
