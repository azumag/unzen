# Wasm instantiate lifecycle measurement

Tracking: parent #301, Step 4 #308.

## Purpose

Step 3 established correctness parity for the small segment-geometry Wasm module. This step measures how the same `WebAssembly.Module` behaves when instantiated once at Worker module scope versus once per request in the repository-pinned Miniflare/workerd runtime.

No production runtime is changed and no Cloudflare deployment is performed.

## Compared workers

Both workers statically import the same `segment-geometry.wasm` through the Cloudflare `CompiledWasm` module path.

- `worker-runtime/wasm-lifecycle-module-worker.mjs`
  - instantiates once during module evaluation
  - `instantiationCount` remains `1` across repeated requests in the same isolate
- `worker-runtime/wasm-lifecycle-request-worker.mjs`
  - instantiates inside `fetch()`
  - `instantiationCount` increases once per request

Both execute the same deterministic geometry check and must return `result: 0`.

## Measurement contract

`tests/wasm-lifecycle-timing.test.ts` records machine-readable JSON events:

```json
{
  "event": "unzen_wasm_lifecycle_timing",
  "scope": "module",
  "startupMs": 0,
  "firstRequestMs": 0,
  "warmRequestMs": [0, 0, 0]
}
```

The numeric values above are schematic; CI supplies the actual measurements. The test only requires timings to be finite and non-negative. It deliberately does **not** assert that one scope is always faster, because hosted-runner scheduling and workerd startup noise would make such a threshold flaky and would overstate what this spike proves.

Measured phases:

1. Miniflare construction through `ready` (`startupMs`)
2. first dispatched request (`firstRequestMs`)
3. three subsequent requests in the same runtime (`warmRequestMs`)

## Lifecycle assertions

The regression test fixes the behavioral contract rather than a performance ranking:

- module-scope: request counts `1..4`, instantiation count always `1`
- request-scope: request counts `1..4`, instantiation counts `1..4`
- both scopes return the same deterministic Wasm result
- disposing and recreating Miniflare resets module-scope counters to `1` on the first request while preserving correctness

The compatibility date remains `2026-08-06`, matching Steps 1 and 3 and the currently pinned workerd support ceiling used by this repository.

## Interpretation

This step can demonstrate lifecycle semantics and provide timing evidence from CI. It cannot establish production Cloudflare cold-start latency or guarantee a stable performance ratio. A real external Worker measurement belongs to Step 5 and requires explicit deployment authorization and credentials.
