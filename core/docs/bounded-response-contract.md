# Bounded response-body contract

The client-side bounded response readers in `packages/client/src/response-body.ts` are the common byte ceiling for untrusted manifest, code/module, cache-verification, and fallback-response payloads.

## Byte ceiling

`maximumBytes` is configuration, not network input. It must be a non-negative JavaScript safe integer. `NaN`, infinities, negative values, and fractional values are rejected before a stream reader, `arrayBuffer()`, or json-only adapter is allowed to consume the payload. A zero-byte ceiling remains valid for an empty body.

The body is still measured while it is read. A missing, malformed, or dishonest `Content-Length` therefore cannot bypass the configured ceiling.

## Structural adapters

Real Fetch `Headers.get()` returns `string | null`, but tests and embedders may provide structural response adapters. Declared-size preflight only interprets a primitive string `Content-Length`; it never coerces a non-string adapter value or invokes its `trim`, `toString`, or `Symbol.toPrimitive` hooks. Malformed string values retain the existing compatibility behavior: they are ignored for the early declared-size optimization and the actual bounded read remains authoritative.

## Cleanup

A response rejected during preflight is cancelled on a best-effort basis. Cleanup failures must not replace the original validation or size error. Once a stream reader has been acquired, reader cancellation and lock release follow the same rule.
