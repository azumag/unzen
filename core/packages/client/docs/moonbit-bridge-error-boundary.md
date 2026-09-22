# MoonBit array-bridge error trust boundary

The MoonBit array bridge calls WebAssembly exports to create, populate, and read array handles. Values thrown or returned by those bridge calls are treated as untrusted at the JavaScript boundary.

## Contract

- Bridge-thrown primitive values keep their useful string representation.
- Ordinary `Error` values keep a readable string `message`.
- Arbitrary object/function failures use the stable `Unknown error` diagnostic; their conversion hooks are not invoked.
- `instanceof Error` and `message` reads are bounded so revoked/hostile Proxies cannot replace the bridge failure taxonomy with native exceptions.
- Invalid result-length values are described by primitive value when safe, or by their JavaScript kind (`object` / `function`) without coercion.
- Existing ABI validation, export names, aggregate element limits, and validation-before-allocation behavior are unchanged.

This is diagnostic and runtime-boundary hardening only. It does not change the MoonBit ABI or WebAssembly execution semantics.
