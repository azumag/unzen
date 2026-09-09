# Cloudflare Workers Wasm adoption decision

Tracking: parent #301, Step 6 #312. Evidence chain: #302/#303, #304/#305, #306/#307, #308/#309, #310/#311.

## Decision

Cloudflare Workers Wasm is **limited-adoption** in `LLM-proto`.

The machine-readable source of truth is [`../policy/cloudflare-wasm-adoption.json`](../policy/cloudflare-wasm-adoption.json). Its production boundary is intentionally explicit:

```text
decision: limited-adoption
productionReplacementAllowed: false
defaultInstantiationScope: module
```

This means Wasm may be used for narrowly scoped experiments and small pure deterministic verification kernels when the evidence requirements below are met. It is **not** an authorization to replace the existing production validator, Coordinator, browser/WebGPU execution path, or stateful orchestration.

## Evidence considered

### Step 1 — runtime module compatibility

The pinned Miniflare/workerd path successfully imports `.wasm` as `WebAssembly.Module` and instantiates it with `WebAssembly.instantiate()` at module scope. The repository compatibility date used by the spike is `2026-08-06`.

This established a usable Worker runtime contract, not production Cloudflare performance.

### Step 2 — Wrangler packaging

Wrangler `4.129.1` dry-run packaging preserved Wasm as a separate upload module rather than inlining the full binary into generated JavaScript.

The first pinned packaging fixture measured:

- JavaScript upload module: `943` bytes
- Wasm upload module: `41` bytes
- exact JavaScript + Wasm upload-module bytes: `984` bytes
- Wasm SHA-256: `f61fd62f57c41269c3c23f360eeaf1090b1db9c38651106674d48bc65dba88ba`

The result removes a packaging-compatibility blocker but does not imply that Wasm reduces bundle size or startup cost for real production kernels.

### Step 3 — correctness parity

A `109` byte `segment-geometry.wasm` fixture was differential-tested against the existing JavaScript manifest-validator geometry path. Curated and deterministic seeded vectors covered valid geometry and failure cases.

The important boundary is that JavaScript remains responsible for structural parsing and numeric-domain preflight. Values outside the explicitly admitted i32 domain fail-close before the Wasm call, avoiding silent JavaScript-to-Wasm integer coercion or wraparound.

For any future candidate, a maintained JavaScript reference implementation and differential test are required evidence. Wasm must not become an opaque second implementation whose behavior cannot be compared mechanically.

### Step 4 — instantiate lifecycle

The same Wasm module was tested with module-scope and request-scope instantiation. Module-scope instantiation occurs once per Worker isolate; request-scope instantiation occurs once per request. Correctness stayed equivalent across repeated requests and isolate recreation.

The CI timing output is diagnostic-only. Hosted-runner noise and local Miniflare/workerd behavior do not establish a stable production performance advantage. Therefore the policy defaults to **module-scope** instantiation when a permitted Worker-local Wasm utility is used, but does not claim a latency win.

### Step 5A — isolated canary preparation

An isolated `workers.dev` canary, pinned response contract, Wrangler dry-run identity check, remote smoke checker, and fail-closed deploy/delete gate were added in #311.

Phase B — a real Cloudflare deploy, public `workers.dev` execution, cold/warm latency measurement, and naturally occurring isolate-change observation — remains **未確認** because external deployment was not explicitly authorized. No account token, account ID, paid service, production route, or external Worker operation was used to reach this decision.

## Allowed scope

A new Wasm candidate is acceptable only when all of the following remain true:

- the kernel is small, pure, and deterministic;
- a JavaScript reference remains available;
- differential test coverage detects JS/Wasm behavior drift;
- input-domain conversion is explicit and fail-close before Wasm execution;
- the Wasm binary identity and relevant toolchain versions are pinned;
- the implementation is isolated from network, storage, secret, and stateful orchestration concerns;
- module-scope instantiation is used unless a measured requirement justifies another lifecycle.

Current examples are small integer geometry checks, small binary-format verification kernels, and the isolated feasibility canary itself.

## Blocked scope

The following are not approved by this decision:

- replacing the existing production manifest validator with Wasm;
- moving Coordinator state machines or Durable Object orchestration into Wasm;
- moving network/storage orchestration into Wasm;
- moving JSON parsing, locators, digests, signatures, or trust-boundary policy wholesale into Wasm;
- adopting Wasm only because it is assumed to be faster without measured production evidence;
- introducing a repository-wide Rust/C build chain or large native-code migration;
- treating Cloudflare Worker Wasm as a substitute for browser WebGPU / #223 architecture work.

Any such change needs a separate issue and new evidence rather than inheriting approval from #301.

## Maintainability trade-off

The spike fixtures are intentionally tiny and have reviewable WAT source. That is suitable for validating the execution contract, but it is not enough evidence to justify a larger hand-maintained Wasm codebase.

A larger candidate should first demonstrate a reproducible source-to-Wasm build, pinned compiler/toolchain identity, reviewable source, deterministic artifact generation, and a maintenance advantage that outweighs the extra language/build boundary. Until then, JavaScript/TypeScript remains the default implementation language for Worker business logic and validation orchestration.

## Security and reliability boundary

Wasm provides a deterministic numeric execution boundary, but it does not replace application-level validation or Cloudflare Worker isolation policy. JavaScript remains responsible for validating external structures and values before entering the Wasm kernel.

The Step 5 deploy gate is a separate safety mechanism and is **not authorization**. The presence of Cloudflare credentials or the approval environment variable alone must not be interpreted as permission to run Phase B.

## Remote unknowns carried forward

The following remain unresolved and are deliberately recorded in the policy:

- Cloudflare production runtime identity for the isolated canary;
- production first-request and repeated warm-request timing;
- behavior across real production isolate restarts/changes.

These unknowns do not block the current limited-adoption decision because production replacement and performance claims are explicitly prohibited.

## Revisit triggers

Revisit this decision when at least one of these becomes concrete:

1. an explicitly authorized isolated remote canary produces reproducible production evidence;
2. profiling identifies a real production CPU hotspot that is a small pure kernel and is a plausible Wasm candidate;
3. a maintainable reproducible Rust/C/other source-to-Wasm toolchain is proposed with clear ownership and artifact reproducibility.

A revisit may widen, narrow, or reject Wasm adoption, but it must update both this ADR and `policy/cloudflare-wasm-adoption.json` together.

## Outcome for #301

The original feasibility question is answered: Cloudflare Workers Wasm is technically viable in the pinned local/runtime/toolchain path and can preserve correctness for a deliberately small kernel. The evidence does **not** justify a broad production migration or a performance claim.

Therefore #301 should close with **limited-adoption**, retaining the current JS/TS production paths and using Wasm only behind the machine-readable evidence boundary above.
