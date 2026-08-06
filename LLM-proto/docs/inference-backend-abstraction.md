# Inference Backend Abstraction (WorkerCapability)

Issue [#94](https://github.com/azumag/unzen/issues/94) introduced a backend
abstraction so a full-model backend can register as a first-class inference
resource WITHOUT pretending to be a `SegmentExecutor`.

The legacy architecture centers on `SegmentExecutor` / `SegmentConfig` /
checkpoint relay: every worker is a segmented WebGPU executor. A full-model
backend (browser-managed model download, document context, user activation)
is a fundamentally different resource with no layer ranges, no VRAM shards,
and no checkpoints of its own. These two kinds (plus a reserved
`server-fallback` kind) are described, validated, and routed through one
common contract.

> 破棄済み (2026-08-06): `browser-built-in-full-model` の具体的な実装
> (Chrome Prompt API backend, issues #92/#93/#95/#100) は、実ブラウザ計測で
> 特別な設定 (フラグ / エンタープライズポリシー) なしには API が露出しない
> ことが確認されたため破棄しました。#95 の実装は revert、#92/#93 の
> harness・descriptor は削除済みです。kind は抽象化としてのみ残ります。

## Backend kinds

| Kind | Meaning |
|---|---|
| `segmented-webgpu` | The legacy 30B segmented route. `SegmentExecutor` remains an INTERNAL implementation detail of this backend; the new contract never exposes segment/checkpoint APIs. |
| `browser-built-in-full-model` | Reserved for a browser-managed full-model backend. No concrete implementation exists (the Chrome Prompt API route was abandoned; see above). |
| `server-fallback` | Reserved for a coordinated server-side fallback, comparable as the same routing input. |

## Contract

`src/inference-backend.ts` defines the request + lifecycle contract:

```ts
interface InferenceBackend {
  describeCapabilities(): Promise<WorkerCapability>;
  prepare(options?: PrepareOptions): Promise<PreparationResult>;
  execute(request: InferenceRequest, signal: AbortSignal): AsyncIterable<InferenceEvent>;
  dispose(): Promise<void>;
}
```

The contract deliberately contains no segment or checkpoint types
(`SegmentConfig` / `Checkpoint` do not appear at the type level, deliverable
7). A full-model backend registers with a full-model `WorkerCapability` and is
never forced to expose segmented APIs.

## WorkerCapability

`WorkerCapability` is the versioned, runtime-validated description of one
backend instance and the ONLY input to candidate selection (deliverable 2, 5):

- backend kind, runtime name/version
- execution mode (`segment` | `full-model`)
- input/output modalities, supported languages
- streaming support, context window, current context usage
- browser-managed model download state
- user activation requirement, execution surfaces, cancellation support
- max concurrency, expected latency, health (recent failure rate + last
  structured `ErrorCode`)
- privacy boundary + allowed network destinations

Validation lives in `src/inference-capability.ts`:

- unsupported schema versions are rejected
- unknown top-level fields are REJECTED by default (`unknownFieldPolicy:
  'reject'`); a caller may explicitly opt into `'ignore'`, and even then the
  field is ignored and never used for routing
- enum values, ranges, and cross-field consistency (e.g. context usage never
  exceeds the context window) are checked
- `assertValidWorkerCapability()` runs at backend registration so an invalid
  capability can never enter the routing table

## Events

`InferenceEvent` is a discriminated union covering everything a backend emits
during execution (deliverable 4):

| Event type | Purpose |
|---|---|
| `token` / `stream` | Streaming token / incremental output |
| `completion` | Successful finish with tokens + text |
| `abort` | Cancellation / abort of the request |
| `context` | Context window usage snapshot |
| `prepare` | Model preparation state change + download progress |
| `error` | Failure carrying the structured `ErrorCode` taxonomy (context overflow is an `error` event with `code: 'context-overflow'`) |

## Routing

`src/backend-registry.ts` selects candidates by capability predicate — never
by backend-specific types. Segmented, built-in, and server backends are
comparable as the same routing input:

```ts
const candidates = registry.selectCandidates((c) =>
  capabilityMatchesRequest(c, request),
);
```

`src/legacy-worker-adapter.ts` is the TEMPORARY adapter for the old Worker
registration protocol (`{ workerId, tier, vramMB }`). It converts a legacy
registration into a segmented `WorkerCapability` so legacy workers remain
routable without changing the existing segmented route behavior (deliverable
9). Its derived numbers (context window, latency, health) are clearly-labeled
estimates; the legacy protocol does not report them. Once every segmented
worker speaks `InferenceBackend`, this module should be deleted.

## Per-backend responsibility boundary

```
                          ┌──────────────────────────────────────┐
                          │            Coordinator               │
                          │  validates capability (fail-fast)    │
                          │  selects candidates by capability    │
                          │  routes requests + consumes events   │
                          │  maps event errors to ErrorCode      │
                          └───────────────┬──────────────────────┘
                                          │ InferenceBackend contract
                    ┌─────────────────────┼──────────────────────────┐
                    │                     │                          │
        ┌───────────▼──────────┐  ┌───────▼──────────────────┐  ┌────▼─────────────┐
        │ segmented-webgpu     │  │ browser-built-in-full-  │  │ server-fallback  │
        │   backend            │  │   model backend         │  │   (reserved)     │
        │                      │  │   (no implementation;   │  │                  │
        │ - segment geometry   │  │    Chrome route was     │  │ - full-model on  │
        │ - segment execution  │  │    abandoned)           │  │   unzen-managed  │
        │ - checkpoint         │  │ - full-model execution  │  │   servers        │
        │   production         │  │ - browser-managed model │  │ - privacy        │
        │ - VRAM shards        │  │   download              │  │   boundary:      │
        │ - worker surface     │  │ - document session      │  │   'server'       │
        │ - SegmentExecutor is │  │ - user activation       │  │                  │
        │   internal here      │  │ - session lifetime      │  │                  │
        └──────────────────────┘  └─────────────────────────┘  └──────────────────┘

   Legacy route (temporary): workers register via the old protocol and are
   adapted by legacy-worker-adapter.ts into a segmented capability. They stay
   routable; execution still flows through the old SegmentExecutor pipeline.
```

> Note: the legacy adapter is currently a tested conversion utility only — the
> wiring that feeds adapted capabilities into the `BackendRegistry` is not yet
> implemented. It is deferred until a segmented worker migrates to
> `InferenceBackend` or the Coordinator integrates capability routing.

The boundary rule: the Coordinator understands ONLY capabilities and events;
each backend owns its execution mechanics. A segmented backend owns segment
geometry (which itself comes from the validated `SegmentedModelManifest`, see
`docs/model-manifest.md`), a full-model backend owns none of it, and neither
is ever exposed to the other.

## Compatibility

- Existing pipeline / checkpoint / coordinator tests are unchanged; adding a
  backend does not change existing segmented route behavior.
- The legacy `Coordinator` (`src/coordinator.ts`) keeps selecting segmented
  workers through `WorkerPool` / `SegmentExecutor`. The capability-based
  registry is the path for backends that are not segmented.

## Focused tests

```bash
cd LLM-proto
npx vitest run tests/inference-backend.test.ts
npx vitest run tests/backend-registry.test.ts
npx vitest run tests/legacy-worker-adapter.test.ts
```
