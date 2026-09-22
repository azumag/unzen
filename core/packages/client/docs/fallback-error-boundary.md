# FallbackHandler error trust boundary

`FallbackHandler` consumes rejection values from browser/network adapters and response-body processing. Those values are untrusted and may be arbitrary JavaScript objects, including revoked Proxies.

## Contract

- Existing `UnzenCancelledError`, `UnzenFunctionError`, and `UnzenNetworkError` values retain their identity when they can be inspected safely.
- Catch-path `instanceof` checks are bounded so revoked Proxies cannot replace the fallback error taxonomy with native `TypeError` exceptions.
- Response-body limit error classification is bounded for the same reason.
- Primitive rejection values keep their useful string representation.
- Ordinary `Error` values keep a readable string `message`.
- Arbitrary object/function rejection values use the stable `Unknown error` diagnostic; `Symbol.toPrimitive`, `valueOf`, and `toString` are not invoked while formatting the failure.
- Cancellation remains authoritative and still surfaces as `UnzenCancelledError`.

This hardening does not change fallback request serialization, response status classification, redirect handling, retry policy, or public API behavior.
