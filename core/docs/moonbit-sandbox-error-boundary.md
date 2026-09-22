# MoonBit sandbox error boundary

`MoonBitSandboxExecutor` treats values crossing asynchronous/runtime catch boundaries as untrusted. Fetch adapters, response-body readers, WebAssembly APIs, caller-owned validation accessors, and executed exports may reject or throw arbitrary JavaScript values, including revoked Proxies and objects with hostile coercion hooks.

The executor therefore formats caught values with a bounded diagnostic helper. Primitive values keep their useful textual form. Ordinary `Error` instances keep a string `message` when it can be read safely. Other object/function values, revoked Proxies, throwing prototype checks, throwing `message` accessors, and non-string `Error.message` values collapse to `Unknown error`. Diagnostic formatting never calls caller-owned `Symbol.toPrimitive`, `valueOf`, or `toString`.

Cancellation classification is bounded separately. An ordinary `UnzenCancelledError` encountered while instantiating a module remains cancellation and is rethrown as `UnzenCancelledError`; a hostile/revoked value cannot escape merely because cancellation identity is being checked.

The wrapping taxonomy is unchanged:

- module fetch/body/integrity failures -> `UnzenNetworkError`;
- execution-option/call normalization, compilation, instantiation, argument/result bridge failures -> `UnzenRuntimeError`;
- user export failures -> `UnzenFunctionError`;
- ordinary caller cancellation -> `UnzenCancelledError`.

This boundary changes only failure normalization. Fetch deduplication, module cache/LRU behavior, integrity validation, WebAssembly compile/instantiate semantics, MoonBit ABI handling, and cancellation precedence remain unchanged.
