# Core client argument-container trust boundary

QuickJS and MoonBit execution accept caller-owned argument arrays. Those containers are captured before sandbox initialization, worker dispatch, WebAssembly instantiation, JSON serialization, or other asynchronous work, so hostile accessors and revoked Proxies cannot leak native/caller exceptions through the public execution path.

## Top-level arguments

Both `snapshotQuickJsCall()` and `snapshotMoonBitCall()` use bounded array operations:

- array classification is guarded so a revoked Proxy follows the stable `... arguments must be an array` validation path;
- `length` is read once and any thrown value is discarded without stringification or coercion;
- the existing argument-count limit is checked before allocating a copy;
- each reached numeric index is read exactly once;
- caller `Symbol.iterator` is never invoked.

QuickJS then serializes only the owned numeric-index snapshot, preserving the existing JSON-serializability and request-byte limits.

## MoonBit ABI array arguments

For `i32[]` and `f64[]` ABI parameters, the top-level argument reference is first captured into the owned call snapshot. Each nested caller-owned array is then handled in two bounded phases:

1. classify the container and read its `length` once;
2. accumulate the existing `MAX_MOONBIT_ARRAY_ELEMENTS` budget before allocating/copying, then read each numeric element once.

A nested `length` or index trap that throws is converted to a stable MoonBit validation error without coercing the thrown value. The copied plain arrays are subsequently passed to scalar/element validation; later bridge code therefore operates on owned arrays rather than caller-owned containers.

Diagnostic array classification is guarded as well, so formatting an invalid/revoked object cannot itself leak `Array.isArray()`'s native revoked-Proxy `TypeError`.

## Preserved limits and semantics

This boundary does not change the public argument model. QuickJS retains its argument-count, JSON, and UTF-8 request-byte limits. MoonBit retains its ABI parameter count, scalar/string limits, aggregate numeric-array element budget, and ABI element validation. Existing fail-fast ordering is preserved: shape and bounded length checks happen before allocations proportional to caller-provided lengths, and argument ownership is established before later execution side effects.
