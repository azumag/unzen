# Segment geometry JS/Wasm differential spike

Tracking: parent #301, Step 3 #306.

## Purpose

This spike checks correctness parity for one deliberately small, side-effect-free part of `model-manifest-validator.ts`: segment index ordering and inclusive transformer-layer range geometry. It does **not** replace the production validator with Wasm.

The JavaScript reference is the existing `validateModelManifestShape()` path. Differential tests construct otherwise-valid fixture manifests and vary only `index`, `layerStart`, `layerEnd`, and `totalLayers`, so a valid/invalid mismatch is attributable to the geometry contract.

## Runtime path

The Worker imports `worker-runtime/wasm-fixtures/segment-geometry.wasm` through the same Cloudflare `CompiledWasm` module path established in Step 1 and instantiates it once at module scope:

```js
import geometryModule from './wasm-fixtures/segment-geometry.wasm';
const instance = await WebAssembly.instantiate(geometryModule);
```

The test runs this Worker through the repository-pinned Miniflare/workerd toolchain with compatibility date `2026-08-06`.

Binary identity:

- bytes: `109`
- SHA-256: `6f311dd115e63448a0e0bf11b12fa29cc1c851112f38732b58ceebc09ba548aa`
- review source: `worker-runtime/wasm-fixtures/segment-geometry.wat`

## Responsibility boundary

JavaScript remains responsible for JSON/object parsing and numeric-domain preflight. Before calling Wasm, all geometry integers must satisfy:

```text
Number.isSafeInteger(value)
0 <= value <= 2_147_483_647
1 <= totalLayers <= 2_147_483_647
```

Values outside that domain fail closed **before** the Wasm function runs. This avoids silently applying WebAssembly i32 wraparound to JavaScript numbers. `NaN`, `Infinity`, strings, missing fields, artifact metadata, locators, digests, signatures, and other structural validation remain entirely in the existing JavaScript validator.

Within the admitted numeric domain, the Wasm function returns compact deterministic reason codes:

| Code | Meaning |
| ---: | --- |
| 0 | valid geometry step |
| 1 | segment index does not match the expected `0..N-1` position |
| 2 | `layerStart` is not the expected contiguous start |
| 3 | `layerEnd < layerStart` |
| 4 | `layerEnd >= totalLayers` |
| 5 | the final segment does not end at `totalLayers - 1` |

Input segment order is not semantically meaningful: JavaScript sorts by `index` before invoking the Wasm checker, matching the current production validator. Layer ranges are inclusive, so `layerStart === layerEnd` represents one layer and is valid when the overall coverage contract is satisfied.

## Differential evidence

`tests/segment-geometry-wasm-differential.test.ts` covers curated vectors for:

- one-segment and multi-segment complete coverage
- shuffled input order
- duplicate and missing indexes
- overlap and gap
- non-zero first layer
- incomplete final coverage
- reversed ranges
- inclusive single-layer range
- model-boundary overflow
- `i32::MAX`-adjacent valid input
- explicit pre-Wasm rejection outside the chosen numeric domain
- structural malformed values retained on the JavaScript side
- deterministic seeded integer vectors to detect JS/Wasm drift

The test also pins every Wasm reason branch and the binary SHA-256. Any parity mismatch fails CI.

## Non-goals

This step does not claim a performance benefit, introduce Rust/C build tooling, move digest/signature/locator validation into Wasm, change #223 browser/WebGPU architecture, or deploy anything to Cloudflare production. Lifecycle and latency comparisons belong to Step 4 of #301.
