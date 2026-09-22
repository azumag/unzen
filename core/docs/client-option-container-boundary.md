# Core client option-container trust boundary

Several browser/client entry points accept caller-owned option bags before any asynchronous work, cache access, worker registration, module initialization, or network request begins. Those top-level containers are treated as an explicit runtime trust boundary.

The following entry points share the same bounded non-array-object classification:

- QuickJS per-execution options (`snapshotQuickJsExecutionOptions()`);
- MoonBit per-execution options (`snapshotMoonBitExecutionOptions()`);
- `MoonBitSandboxExecutor` constructor options;
- `CodeFetcher` constructor options;
- Unzen cache-worker registration options (`registerUnzenCacheWorkerWith()`).

JavaScript's `Array.isArray()` normally performs no caller-visible property access, but it throws a native `TypeError` for a revoked Proxy. The client therefore performs array classification behind a guarded helper. Non-object values, arrays, and revoked Proxies all fail through the entry point's existing stable `... options must be an object` diagnostic instead of leaking a native Proxy error.

After container classification succeeds, each boundary keeps its existing snapshot semantics: relevant fields are read once under their existing getter/Proxy-read guard, defaults and validation order are unchanged, and later work uses the captured values. A failed container classification does not read option fields.

Validation continues to precede side effects. In particular, QuickJS/MoonBit execution options are rejected before sandbox or worker execution, `CodeFetcher` constructor options are rejected before later cache/network work, MoonBit sandbox options are rejected before constructor initialization, and cache-worker options are rejected before `register()` is inspected or invoked.

This boundary only covers the top-level option containers listed above. Nested caller-owned values (for example MoonBit import maps, ABI metadata, or AbortSignals) retain their own validation and trust-boundary contracts and should be hardened independently when needed.
