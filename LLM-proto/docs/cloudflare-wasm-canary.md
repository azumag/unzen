# Isolated Cloudflare Wasm feasibility canary

Tracking: parent #301, Step 5 #310. Local prerequisites were established by Steps 1–4.

## Status

Phase A is intentionally credential-free and deploy-free. The repository contains enough material to package, inspect, and locally smoke-test an isolated canary, but **no external Cloudflare Worker is deployed by CI or by the implementation itself**.

Remote deployment is a separate Phase B action and requires explicit authorization plus Cloudflare credentials at execution time.

## Canary boundary

`wrangler-wasm-canary.jsonc` names a dedicated Worker:

```text
unzen-wasm-feasibility-canary
```

Its only entrypoint is `worker-runtime/wasm-canary-worker.mjs`. The config has:

- compatibility date `2026-08-06`
- `workers_dev: true`
- no account id
- no routes or custom domains
- no KV/R2/D1/Durable Object/service bindings
- no environment variables

The canary imports the Step 3 `segment-geometry.wasm` as a Cloudflare compiled Wasm module and performs one deterministic check. A successful GET response is pinned by `tools/wasm_canary_contract.mjs`:

```json
{
  "status": "pass",
  "canary": "unzen-cloudflare-wasm-feasibility",
  "contractVersion": "1.0.0",
  "moduleType": "WebAssembly.Module",
  "wasmBytes": 109,
  "wasmSha256": "6f311dd115e63448a0e0bf11b12fa29cc1c851112f38732b58ceebc09ba548aa",
  "result": 0
}
```

The SHA value is a contract marker in the Worker response; `tools/check_wrangler_wasm_canary.mjs` independently binds it to the actual binary emitted by Wrangler dry-run packaging.

## Credential-free CI evidence

CI runs:

```sh
node tools/check_wrangler_wasm_canary.mjs
```

The checker uses pinned Wrangler `4.129.1` with `deploy --dry-run --outdir`. It fails unless:

- config identity matches the dedicated canary
- only `workers.dev` publication is configured
- no production/environment binding keys are present
- the 109-byte Wasm module is emitted separately
- its SHA-256 is preserved exactly
- generated JavaScript does not inline the full Wasm binary as base64
- generated JavaScript carries the pinned remote smoke contract markers

This command does not require a Cloudflare token and does not perform a deployment.

## Fail-closed deployment gate

`tools/wasm_canary_deploy_gate.mjs` is the only documented path for an eventual remote deploy/delete. Without `--execute`, it only prints a plan and performs no Cloudflare action:

```sh
node tools/wasm_canary_deploy_gate.mjs deploy
node tools/wasm_canary_deploy_gate.mjs delete
```

Actual execution additionally requires all of the following at runtime:

1. `--execute`
2. `UNZEN_CLOUDFLARE_CANARY_DEPLOY_APPROVED=I_APPROVE_ISOLATED_WASM_CANARY`
3. `CLOUDFLARE_API_TOKEN` to be present
4. `CLOUDFLARE_ACCOUNT_ID` to be present

The gate does not print either credential value. Repository configuration does not contain those values.

These mechanics are a safety boundary, **not authorization**. Even if an environment happens to contain those variables, Phase B must not be run unless external Cloudflare deployment has been explicitly approved for this experiment.

## Remote smoke checker

If Phase B is later authorized and the isolated canary is deployed, the response can be measured with:

```sh
node tools/check_wasm_canary_remote.mjs https://<isolated-canary>.<subdomain>.workers.dev/
```

The checker rejects HTTP, embedded URL credentials, and non-`workers.dev` hosts. It performs repeated GETs, validates every response against the pinned contract, and records per-request elapsed time. Those measurements remain diagnostic and must not be interpreted as a stable performance ranking without repeated controlled sampling.

## Cleanup

After authorized remote measurement, cleanup uses the same fail-closed wrapper:

```sh
node tools/wasm_canary_deploy_gate.mjs delete --execute
```

with the same explicit approval and credential requirements. Cleanup should be recorded in #310 before Phase B is considered complete.

## What remains unknown without Phase B

Local evidence now covers module import, Wrangler packaging, correctness parity, isolate lifecycle, and canary package identity. Without an authorized remote deploy, the following remain deliberately unverified:

- actual Cloudflare production runtime identity for this canary
- external first-request and warm-request timings
- behavior across naturally occurring production isolate changes
- deployment and cleanup behavior for the connected Cloudflare account

Those unknowns should be carried explicitly into Step 6 rather than inferred from Miniflare results.
