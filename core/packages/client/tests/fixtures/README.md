# MoonBit test fixtures

`interop-custom-namespace.wasm` is compiled from `moonbit-poc/interop` with
MoonBit 0.1.20260126. Its only source configuration difference is:

```json
"imported-string-constants": "unzen:strings"
```

To regenerate it without modifying the source fixture:

1. Copy `moonbit-poc/moon.mod.json` and the `moonbit-poc/interop` directory to
   a temporary directory.
2. Change the copied `interop/moon.pkg.json` setting shown above.
3. Run `NEW_MOON=0 moon build --target wasm-gc --release` in that directory.
4. Copy `_build/wasm-gc/release/build/interop/interop.wasm` here as
   `interop-custom-namespace.wasm`.

Expected SHA-256:

```text
bd212ee0a04c5a5b33b74b2537327c43acf9442548ff8f6da0f9a2f2b723973a
```
