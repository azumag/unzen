# MoonBit import-container trust boundary

`MoonBitSandboxExecutor` treats the caller-supplied `imports` map and every nested import module as untrusted runtime containers. Construction snapshots those containers before the executor publishes any usable state.

## Container classification

Both the top-level import map and each nested module must be non-null, non-array objects. Classification uses the client's guarded non-array-object helper because `Array.isArray()` throws a native `TypeError` for a revoked Proxy. Revoked Proxies therefore stay inside the existing public diagnostics instead of leaking a native Proxy failure:

- `MoonBit imports must be an object`
- `MoonBit import module "<name>" must be an object`

Ordinary arrays and non-object values continue to use the same validation paths.

## Snapshot reads

After classification succeeds, enumerable module/import names are read with `Object.keys()` under a guard and each reached property is read under the existing property-read guard. Caller-thrown values are discarded rather than stringified or coerced. Enumeration or property-read failures therefore use the stable `MoonBit imports could not be read` diagnostic.

The copy target and every copied module have null prototypes. Caller-provided iterators and object prototypes are not used while copying the import map.

## Merge semantics

The hardening does not change import precedence. Runtime defaults are copied first and caller imports are copied second, so caller entries still override defaults on a per-module, per-import basis. A failed snapshot remains local to construction: the executor does not expose a partially copied caller import map.
