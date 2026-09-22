# Demo execution error boundary

Tracking: #1408.

The demo normally consumes structured `executeWithDiagnostics()` results, and that API is expected not to throw. `runDemo()` still keeps a defensive outer `catch` so an unexpected SDK or adapter failure cannot leave the UI stuck in an executing state.

Values entering that defensive catch are treated as untrusted JavaScript values. In particular, the fallback must not call `String(value)` on arbitrary objects or functions because their `Symbol.toPrimitive`, `valueOf`, or `toString` hooks may execute caller-controlled code or throw. A revoked Proxy can also throw while being classified with `instanceof` or while a property such as `message` is read.

`demo-error-boundary.js` therefore owns the formatting boundary:

- primitive thrown values keep their useful built-in `String()` representation;
- object/function values are never string-coerced;
- `instanceof Error` is bounded so revoked/hostile Proxies degrade safely;
- `Error.message` is read inside a bounded operation;
- object/function-valued messages are not coerced;
- unreadable or otherwise unsafe values become the stable `Unknown error` message.

The fallback result remains `{ success: false, error: { code: 'unknown', ... }, diagnostics: null }`. State transitions, controller cleanup, statistics, result rendering, retry behavior, SDK protocol semantics, deployment configuration, and external side effects are unchanged.

Focused regressions cover ordinary `Error` values, primitives, hostile object/function coercion hooks, throwing `message` access, object-valued messages, revoked Proxies, and Proxy-wrapped Errors.
