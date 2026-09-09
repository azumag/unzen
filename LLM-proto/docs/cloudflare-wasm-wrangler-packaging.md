# Cloudflare Workers Wasm Wrangler packaging spike

Tracking: parent #301, Step 2 #304. Step 1 evidence: #302 / PR #303.

## Purpose

Step 1 proved the repository-pinned Miniflare/workerd path for importing a binary `.wasm` dependency as `WebAssembly.Module` and instantiating it at module scope. This step verifies the **Wrangler upload packaging shape** without deploying anything to Cloudflare.

The check deliberately uses `wrangler deploy --dry-run --outdir ...`. Cloudflare documents `--dry-run --outdir` as the way to inspect exactly what Wrangler would upload, and documents `.wasm` / `.wasm?module` as non-JavaScript modules imported as `WebAssembly.Module` rather than being inlined into the JavaScript bundle.

References:

- https://developers.cloudflare.com/workers/wrangler/bundling/
- https://developers.cloudflare.com/workers/wrangler/commands/workers/
- https://developers.cloudflare.com/workers/wrangler/install-and-update/

## Pinned toolchain

The packaging probe pins Wrangler **4.129.1** directly in the `npx` package selector used by `tools/check_wrangler_wasm_packaging.mjs`:

```text
npx --yes --package=wrangler@4.129.1 wrangler ...
```

This keeps the Step 2 dependency isolated from the existing `LLM-proto` runtime/test dependency graph while still preventing an unqualified `npx wrangler` from silently moving to a newer release. The probe first runs `wrangler --version` and fails unless the reported version contains `4.129.1`.

The Worker compatibility date remains **2026-08-06**, matching the Step 1 compatibility contract.

## Dry-run configuration

`wrangler-wasm-packaging.jsonc` points Wrangler at the Step 1 Worker and fixture:

- entry module: `worker-runtime/wasm-esm-compat-worker.mjs`
- fixture: `worker-runtime/wasm-fixtures/add-i32.wasm`
- compatibility date: `2026-08-06`

The probe creates a temporary output directory, runs Wrangler dry-run packaging, inspects every emitted file, writes a machine-readable JSON report, and deletes the temporary output afterward.

No Cloudflare account ID, API token, route, custom domain, or production deployment is used.

## Fixture identity

The expected Wasm payload is unchanged from Step 1:

- bytes: `41`
- SHA-256: `f61fd62f57c41269c3c23f360eeaf1090b1db9c38651106674d48bc65dba88ba`

The probe fails unless exactly one emitted file has the Wasm magic header and this exact byte length and SHA-256 identity.

## Regression contract

A passing probe establishes all of the following for the pinned Wrangler release:

1. `wrangler deploy --dry-run --outdir` succeeds without a Cloudflare deployment.
2. Wrangler emits at least one JavaScript module and a separate Wasm module.
3. The emitted Wasm payload preserves the 41-byte fixture identity.
4. The generated JavaScript references a `.wasm` module and does not contain the complete fixture as a base64 inline payload.
5. Wrangler's `Total Upload` value is parsed into byte counts for machine-readable evidence.
6. The emitted module count, JavaScript module count, Wasm module count, per-file byte length, and SHA-256 are recorded in the JSON report.

Cloudflare's documented default import contract supplies the semantic mapping `.wasm` -> `WebAssembly.Module`; the dry-run evidence verifies that this input is packaged as a distinct Wasm upload module rather than being hidden inside the JavaScript bundle.

## Run locally

From `LLM-proto`:

```text
npm run verify:wrangler-wasm-packaging
```

The command may download the exact pinned Wrangler package through npm when it is not already cached. It does not require Cloudflare credentials and does not deploy.

## Boundaries

This Step does **not** establish production Cloudflare runtime behavior, performance benefit, Rust/C build-chain suitability, standard `import source` syntax support, or any #223 browser/WebGPU architecture decision. Those remain later steps under #301.
