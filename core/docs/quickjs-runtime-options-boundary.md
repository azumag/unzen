# QuickJS runtime execution-input boundary

`QuickJSRuntime.execute()` is an advanced server API that accepts caller-owned execution options and argument arrays. Those inputs are validated and snapshotted before a QuickJS context is allocated.

The runtime treats the top-level options container as a trust boundary. Non-object values, arrays, and revoked Proxies all fail through the stable `QuickJS execution options must be an object` diagnostic. A readable object then has `timeout` captured once; a throwing getter or Proxy `get` trap fails through `QuickJS execution options could not be read`.

The top-level argument container is classified through the same fail-closed boundary. A revoked Proxy cannot escape through `Array.isArray()` and instead fails through `QuickJS arguments must be an array`. Once classified as an array, `length` is read under the existing guard and numeric indexes are copied into an owned array before JSON serialization; caller iteration is not used.

Caller-thrown values are not inspected, stringified, or coerced. Rejected inputs therefore cannot execute additional caller code through error formatting, and validation failure occurs before sandbox allocation.

This hardening does not change valid timeout or argument semantics: omitted `timeout` still defaults to 50 ms, explicit values remain bounded by `MAX_FUNCTION_TIMEOUT`, argument count/serialization/byte ceilings remain unchanged, and all existing sandbox behavior is preserved.
