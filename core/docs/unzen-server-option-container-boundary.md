# UnzenServer option-container boundary

`UnzenServer` accepts caller-owned configuration and registration-option objects at three server-side boundaries: constructor configuration, QuickJS function options used by `define()` / `defineRaw()`, and MoonBit definition options used by `defineMoonbit()`.

Each top-level container is classified before any field is read. Non-object values, arrays, and revoked Proxies fail closed through the existing stable diagnostics:

- `UnzenServer baseUrl configuration must be an object`
- `Unzen function options must be an object`
- `MoonBit definition options must be an object`

`Array.isArray()` is itself guarded because it throws a native `TypeError` for a revoked Proxy. The server does not expose that native failure to callers. Once a container is accepted, the existing field snapshots remain unchanged: configuration and option fields are read once, and accessor or Proxy `get` failures are normalized through the existing `... could not be read` diagnostics.

Timeout validation is also bounded. Invalid primitive timeout values keep their existing useful diagnostic rendering, but invalid object and function values are rendered as `<object>` and `<function>` without calling `String(value)`, `Symbol.toPrimitive`, `valueOf`, or `toString` on caller-owned values. Validation therefore cannot execute caller code merely to format an error. The accepted timeout range remains the existing integer range `1..MAX_FUNCTION_TIMEOUT`.

Validation ordering is part of the contract. Invalid `define()` options fail before function inspection, invalid `define()` / `defineRaw()` options do not register a function or consume a manifest version, and invalid MoonBit options fail before module file I/O. Rejected inputs therefore cannot mutate registry/version state through the option-classification or timeout-diagnostic paths.

This boundary hardening does not alter valid configuration, timeout, fallback, MoonBit export, ABI, registry, manifest, or execution semantics. It also performs no production deployment, external-model call, credential access, or billing-affecting operation.
