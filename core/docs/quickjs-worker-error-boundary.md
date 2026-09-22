# QuickJS worker host error boundary

The dedicated QuickJS Web Worker treats values thrown by host/runtime operations as untrusted. QuickJS loader initialization, caller-owned call snapshots, and unexpected worker-handler failures can reject with arbitrary JavaScript values, including revoked Proxies and objects with hostile coercion hooks.

Those host/runtime failures are formatted with a bounded diagnostic helper. Primitive values keep their useful textual form. Ordinary `Error` instances keep a string `message` when it can be read safely. Other object/function values, revoked Proxies, throwing prototype checks, throwing `message` accessors, and non-string `Error.message` values collapse to `Unknown error`. The host diagnostic never calls caller-owned `Symbol.toPrimitive`, `valueOf`, or `toString`.

This is deliberately separate from `formatSandboxError()`. Values explicitly dumped from sandboxed QuickJS code keep the existing sandbox formatting behavior, so function diagnostics and timeout detection are unchanged.

The worker protocol and error taxonomy are unchanged: initialization failures remain failed `init-result` responses, call-boundary/unexpected host failures remain `runtime_error`, sandbox syntax/execution failures retain their existing `function_error` / `deadline_exceeded` behavior, and cancellation/context lifecycle semantics are unaffected.
