# Abort-error classification trust boundary

Client catch paths may receive arbitrary JavaScript rejection values from browser APIs, polyfills, mocks, or other asynchronous boundaries. `isAbortError()` therefore treats the rejection value as untrusted rather than assuming it is a normal `Error` instance.

The classifier accepts an object only when a single bounded read of its `name` field yields the exact string `AbortError`. The `name` read is wrapped so a revoked Proxy or throwing getter cannot replace the caller's normal network/runtime error mapping with a native or caller-controlled exception. A value thrown by the getter is discarded; it is not stringified, coerced, or otherwise inspected.

Primitive values, null, unreadable objects, and non-`AbortError` names classify as non-abort errors. This hardening does not change cancellation semantics for normal browser `DOMException` values or `{ name: 'AbortError' }` stand-ins.
