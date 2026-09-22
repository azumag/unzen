# QuickJS server runtime error boundary

`QuickJSRuntime.execute()` treats exceptions from host/runtime operations as untrusted. QuickJS context setup, evaluation, dumping, interrupt configuration, and adjacent runtime calls can throw arbitrary JavaScript values, including revoked Proxies and objects with hostile coercion hooks.

The outer execution catch preserves ordinary `UnzenRuntimeError` and `UnzenFunctionError` instances, but the identity checks themselves are bounded so revoked/hostile values cannot escape through `instanceof`. Unknown host/runtime failures use a bounded diagnostic: primitive values keep their useful textual form, ordinary `Error` instances keep a string `message` when it can be read safely, and other object/function values collapse to `Unknown error`. The diagnostic never calls caller/runtime-owned `Symbol.toPrimitive`, `valueOf`, or `toString`.

This boundary is deliberately separate from `formatSandboxError()`. Values intentionally dumped from sandboxed QuickJS code keep the existing sandbox formatting and timeout/function-error classification.

Direct-call validation still completes before a context is allocated, each execution still disposes its context in `finally`, and no timeout, sandbox policy, public API, or protocol semantics are changed by this hardening.
