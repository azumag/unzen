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
979a94c6bb2f8ae945cf302c9ebff3c0883e69d9056637f76d0d33ed9c1e0186
```
