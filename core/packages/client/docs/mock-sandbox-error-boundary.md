# MockSandboxExecutor error trust boundary

`MockSandboxExecutor` executes caller-provided JavaScript in Node.js `vm` for development and tests. Values thrown by that code cross back into the host runtime and must be treated as untrusted.

## Contract

- Known host-owned `UnzenFunctionError` and `UnzenCancelledError` values retain their existing identity.
- `instanceof` checks on arbitrary thrown values are bounded because a revoked Proxy can throw during prototype traversal.
- Primitive thrown values keep their useful string representation.
- Ordinary `Error` values keep a string `message` when that property can be read safely.
- Arbitrary object/function values use a stable `Unknown error` diagnostic. Their `Symbol.toPrimitive`, `valueOf`, and `toString` hooks are not invoked while producing the wrapper error.
- Revoked Proxies and throwing `message` accessors therefore fail closed through `UnzenFunctionError` instead of leaking native or caller-controlled exceptions.

This boundary does not make the mock executor a security sandbox. It only keeps its documented error taxonomy stable when development/test code throws hostile values. Cancellation ordering, VM isolation behavior, argument snapshotting, and the public executor API are unchanged.
