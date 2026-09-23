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

The production JavaScript validator admits topology values only when integer identity is exact in JavaScript:

```text
Number.isSafeInteger(value)
0 <= segment.index
0 <= layerStart <= layerEnd
1 <= totalLayers
```

Contiguity (`previous.layerEnd + 1`) and completeness (`totalLayers - 1`) arithmetic runs only after every topology value has passed that safe-integer gate. This avoids precision-collapse cases above `Number.MAX_SAFE_INTEGER`, where distinct mathematical layer numbers can become the same JavaScript `number` (for example, an unsafe `x` can satisfy `x + 1 === x`). Such inputs fail closed before topology arithmetic.

The Wasm differential worker deliberately uses a narrower execution domain. Before calling Wasm, all geometry integers must additionally satisfy:

```text
0 <= value <= 2_147_483_647
1 <= totalLayers <= 2_147_483_647
```

Values outside that Wasm-specific domain fail closed **before** the Wasm function runs. This avoids silently applying WebAssembly i32 wraparound to JavaScript numbers. `NaN`, `Infinity`, strings, missing fields, artifact metadata, locators, digests, signatures, and other structural validation remain entirely in the existing JavaScript validator.

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

## Request input boundary

The differential Worker treats its POST body as a bounded control document rather than delegating the entire body to `Request.json()`.

- the request stream is read incrementally with a hard `2 MiB` byte ceiling before a contiguous decode buffer is allocated;
- accepted bytes are decoded as UTF-8 with fatal decoding, so malformed byte sequences cannot be normalized to `U+FFFD` before `JSON.parse()`;
- invalid UTF-8, malformed JSON, missing bodies, and over-limit bodies keep the existing public malformed-body response: HTTP `400` with `reason=invalid-json` and `wasmCalled=false`;
- a valid UTF-8 BOM remains accepted by the platform `TextDecoder` behavior;
- geometry validation, reason codes, the Wasm ABI, and the pinned Wasm binary are unchanged.

This is request-memory/input-integrity hardening for the local differential Worker. It is not transport authentication, production deployment evidence, or stronger model/WebGPU evidence for #167.

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

`tests/segment-geometry-wasm-request-boundary.test.ts` separately covers malformed UTF-8 that replacement decoding would otherwise turn into valid JSON, a syntactically valid request above the explicit byte ceiling, and valid BOM-prefixed JSON.

`tests/model-manifest-validator.test.ts` separately pins the production JavaScript numeric trust boundary, including unsafe `totalLayers`, segment indexes, range endpoints, and the precision-collapse adjacency case where `x + 1 === x`.

The test also pins every Wasm reason branch and the binary SHA-256. Any parity mismatch fails CI.

## Non-goals

This step does not claim a performance benefit, introduce Rust/C build tooling, move digest/signature/locator validation into Wasm, change #223 browser/WebGPU architecture, or deploy anything to Cloudflare production. Lifecycle and latency comparisons belong to Step 4 of #301.
