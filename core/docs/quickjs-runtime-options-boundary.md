# QuickJS runtime execution-option boundary

`QuickJSRuntime.execute()` is an advanced server API that accepts caller-owned execution options. Those options are validated and snapshotted before a QuickJS context is allocated.

The runtime treats the top-level options container as a trust boundary. Non-object values, arrays, and revoked Proxies all fail through the stable `QuickJS execution options must be an object` diagnostic. A readable object then has `timeout` captured once; a throwing getter or Proxy `get` trap fails through `QuickJS execution options could not be read`.

Caller-thrown values are not inspected, stringified, or coerced. Rejected options therefore cannot execute additional caller code through error formatting, and validation failure occurs before sandbox allocation.

This hardening does not change valid timeout semantics: omitted `timeout` still defaults to 50 ms, explicit values remain bounded by `MAX_FUNCTION_TIMEOUT`, and all existing code/argument validation and sandbox behavior remain unchanged.
