# Cloudflare Workers Wasm ESM compatibility spike

Tracking: #301, Step 1: #302.

## Purpose

This spike answers one narrow question: can the repository-pinned Cloudflare local runtime load a binary `.wasm` dependency from an ES Modules Worker as a `WebAssembly.Module`, instantiate it at module scope, and produce deterministic results?

It does **not** select Wasm for the unzen production architecture and does not change #223 browser/WebGPU endpoint semantics.

## Current toolchain

`LLM-proto/package.json` currently declares:

- Node.js `>=22`
- `miniflare` `^4.20260521.0`
- no direct Wrangler dependency in `LLM-proto`

The current lockfile resolves Miniflare `4.20260730.0`.

The compatibility spike uses `compatibilityDate: 2026-08-06` and Miniflare module mode with this explicit rule:

```ts
{ type: 'CompiledWasm', include: ['**/*.wasm'] }
```

`2026-08-06` is pinned intentionally: the repository-pinned workerd binary used by Miniflare reported this as its newest supported compatibility date in CI. The first spike attempt used `2026-09-09` and failed before module loading with that exact runtime ceiling, so this test records the runtime/toolchain actually present rather than assuming the wall-clock date is supported.

The Worker uses the Cloudflare-documented module form:

```js
import addModule from './wasm-fixtures/add-i32.wasm';

const instance = await WebAssembly.instantiate(addModule);
```

The Worker fails at module evaluation unless the imported value is a `WebAssembly.Module`.

## Fixture

`worker-runtime/wasm-fixtures/add-i32.wasm` is a 41-byte deterministic module exporting:

```text
add(i32, i32) -> i32
```

Pinned identity:

- bytes: `41`
- SHA-256: `f61fd62f57c41269c3c23f360eeaf1090b1db9c38651106674d48bc65dba88ba`
- expected `add(20, 22)`: `42`

The test executes two requests against the same Miniflare runtime and expects the same result. A negative case deliberately wires `.wasm` as `Data`; startup must fail because the imported value is not a `WebAssembly.Module`.

## What this establishes

A green test establishes only the local Miniflare/workerd compatibility contract for an ES Modules Worker importing a compiled Wasm module and instantiating it through `WebAssembly.instantiate()`.

It does not establish:

- Wrangler upload/package behavior
- a production Cloudflare deployment
- cold-start or CPU performance benefit
- Rust/C build-chain suitability
- browser/Workers shared-core architecture
- standard JavaScript `import source` syntax support

In particular, this Step intentionally does **not** use `import source`. Cloudflare's documented `.wasm` module import returning `WebAssembly.Module` is the compatibility surface being tested first. Wrangler packaging is Step 2 of #301.

## References

- https://developers.cloudflare.com/workers/runtime-apis/webassembly/javascript/
- https://developers.cloudflare.com/workers/testing/miniflare/core/modules/
- https://developers.cloudflare.com/workers/vite-plugin/reference/non-javascript-modules/
