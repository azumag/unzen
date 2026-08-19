# Durable Coordinator (Issue #103)

`DurableCoordinator` (`src/durable-coordinator.ts`) is the durable execution
path for the Coordinator role, fixing the prototype's process-local state,
`req-1` request IDs, silent worker overwrites, and non-aborting timeouts.
The legacy `Coordinator` / `Pipeline` / `WorkerPool` / `CheckpointStore`
remain as the contract-tested prototype; this module is the #103 deliverable.

Status: `production-storage-implemented / deployment-not-yet-evidenced`.
Coordinator behavior is covered by the in-memory contract suite, and
`DurableObjectRepository` adds a persistent adapter for the synchronous KV API
of a SQLite-backed Cloudflare Durable Object. The adapter suite deliberately
uses clone-on-read storage semantics and rebuilds both the repository and
Coordinator to verify request status, idempotency, worker state, attempts, and
results survive an instance restart. A deployed Cloudflare run is still a
separate evidence step and must not be inferred from these tests.

## Modules

| Module | File | Role |
|---|---|---|
| IDs | `src/ids.ts` | UUIDv7 + monotonic-suffix IDs for request/attempt/lease/worker-generation |
| Errors | `src/errors.ts` | Structured error taxonomy, retry policy, isolation classification |
| State machine | `src/request-state-machine.ts` | Validated transition graph (accepted→queued→leased→running→completed + cancelled/retry-wait/failed) |
| Durable repository contract | `src/durable-repository.ts` | `DurableRepository` interface + `InMemoryRepository` reference behavior |
| Durable Object repository | `src/durable-object-repository.ts` | SQLite Durable Object synchronous-KV production persistence adapter |
| Checkpoint envelope | `src/checkpoint-envelope.ts` | Identity-bound + digest + TTL checkpoint envelope |
| Worker registry | `src/worker-registry.ts` | Connection-generation policy (revoke on reconnect, no revive) |
| Lease manager | `src/lease-manager.ts` | Active-lease matching for result/failure/checkpoint acceptance |
| Durable types | `src/durable-types.ts` | Shared records + identity-carrying wire types |
| Durable Coordinator | `src/durable-coordinator.ts` | Request lifecycle, cancellation, retry, lookup |
| Abortable timeout | `src/pipeline-utils.ts` | `withAbortableTimeout` (aborts underlying work on timeout/cancel) |

## Request identity / idempotency

- All IDs are UUIDv7 (time-ordered) with a process-local monotonic suffix so
  they are collision-resistant across Coordinator instances and restarts.
- An API caller may supply an idempotency key. The mapping is stored in the
  repository; a duplicate submission returns the existing request's
  status/result and **never double-executes**.
- Request / attempt / lease IDs are separate namespaces.

## Storage boundaries

`DurableRepository` keeps state split by responsibility:

| Boundary | Repository methods |
|---|---|
| request state | `createRequest` / `getRequest` / `transitionStage` (CAS) |
| idempotency | `putIdempotencyMapping` / `getIdempotencyMapping` |
| attempt history | `appendAttempt` / `listAttempts` / `updateAttempt` |
| worker registration / generation | `putWorker` / `getWorker` / `deleteWorker` / `listWorkers` |
| lease | `putLease` / `getActiveLease` / `deleteLease` / `listActiveLeases` |
| checkpoint metadata / payload | `putCheckpoint` / `getCheckpoint` / `collectExpiredCheckpoints` |
| streaming cursor | `putStreamCursor` / `getStreamCursor` |
| completion / result metadata | `commitCompletion` (CAS) / `getResult` |
| cancellation state | `putCancellation` / `getCancellation` |

Two implementations exist:

- `InMemoryRepository`: fast reference implementation and test double.
- `DurableObjectRepository`: persistent implementation backed by
  `ctx.storage.kv` from a **SQLite-backed** Durable Object.

The Durable Object adapter intentionally depends on a small structural
`DurableObjectSyncKvStorage` interface rather than importing
`cloudflare:workers`; this keeps the prototype executable in Node/Vitest while
allowing a Worker to pass `this.ctx.storage.kv` directly.

The adapter stores each boundary under a separate key prefix and maintains a
lease-id index so lease reclamation does not require a full scan. Request and
worker records are returned through a top-level write-through proxy because the
existing #103 Coordinator/registry contract mutates those records after read;
Durable Object storage returns cloned values, so the proxy persists each such
mutation synchronously instead of relying on in-process object identity.

Completion is committed **exactly once** via compare-and-set
(`commitCompletion`): an already committed result returns `duplicate`, while a
completion arriving in the wrong request stage returns `conflict` and never
overwrites the stored result.

### Cloudflare placement

The repository belongs inside the Durable Object that owns one Coordinator
coordination shard. Do **not** route every Unzen workload to a single global
object. Choose a stable shard key (for example tenant/model/routing shard), and
route all operations that must share idempotency, leases, and request state to
the same object.

New deployments should configure this Durable Object class with SQLite storage
(`new_sqlite_classes`) and construct the repository from `ctx.storage.kv`.
No `await` occurs between the synchronous read/compare/write operations used by
CAS paths.

## State machine

```
accepted ──▶ queued ──▶ leased ──▶ running ──▶ completed
              │  ▲        │  ▲       │   │
              │  │        ▼  │       │   ├──▶ retry-wait ──▶ queued
              │  └── failed  │       ▼   │
              ▼              └──▶ failed │
            failed                    └──▶ cancelled
```

- `retry-wait` is entered after a retryable failure and returns to `queued`.
- `queued → failed` and `retry-wait → failed` allow unschedulable/deadline
  failures instead of leaving requests hanging.
- `running → queued` is the multi-segment checkpoint/resume transition.
- All transitions are validated; late updates from terminal states are rejected.

## Assignment identity / result acceptance

Every assignment carries `requestId, attemptId, leaseId, workerId,
workerGeneration, segmentIndex, modelManifestDigest`. Results, failures, and
checkpoints echo that identity. The Coordinator commits only when the identity
matches the active lease exactly. A mismatched attempt/lease/worker/generation/
segment, expired lease, or request with no active lease is suppressed and never
committed.

## Checkpoint integrity

Checkpoints use `CheckpointEnvelope` and are bound to producer identity, worker
generation, model manifest digest, format version, payload length + SHA-256,
createdAt/TTL, and optional previous-checkpoint digest.
`validateCheckpointEnvelope` runs at the Coordinator boundary before storage or
relay. Expired checkpoints are collected periodically and request
terminalization removes remaining checkpoints.

## Worker registration / connection generation

- One generation is issued per transport connection/auth session.
- Re-registration on a new connection revokes the old generation and reclaims
  its leases.
- Re-registration on the same connection is a capability refresh.
- Heartbeats never revive a revoked generation; unknown/stale generations are
  structured errors.
- Capability (including manifest VRAM requirements) is validated at registration.

With `DurableObjectRepository`, worker heartbeat/stage mutations are persisted
through the write-through record returned by `getWorker`/`listWorkers`, so a
fresh repository instance observes the latest worker state rather than the
pre-heartbeat value.

## Error taxonomy

`ErrorCode` separates worker health from task failure. Task-level failures
(`invalid-input`, `unsupported-request`, `context-overflow`) do not disconnect a
healthy worker. Worker/transport/protocol/identity/integrity failures can be
isolated according to `retryPolicyFor` / `isIsolatable`.

## Cancellation / timeout

- Per-request `AbortController`; caller signal and deadline both propagate to
  `SegmentExecutor.execute(..., { signal })`.
- `withAbortableTimeout` aborts underlying work on segment timeout.
- Cancellation is terminal and is not converted into server fallback.
- `cancel(requestId)` persists cancellation metadata and acknowledgement state.

## Streaming-cancel / failure / fallback policy

The stream cursor records the last committed segment. A checkpoint is the
resume boundary.

- **Cancel**: stop remaining execution, move to `cancelled`, suppress late
  chunks/checkpoints, and never retry/fallback.
- **Failure**: retryable worker/transient failures resume from the last
  checkpoint up to `maxRetries`; non-retryable failures terminate the request.
- **Fallback**: there is no implicit server fallback inside the Coordinator;
  only bounded retry-on-another-worker is performed according to error policy.

## Status / result lookup

`getStatus(requestId)` exposes stage, attempt history, retry count, timing,
current segment, and the committed result. `getResult(requestId)` returns the
persisted `InferenceResult`.

For the Durable Object adapter, these lookups are storage-backed and remain
available after a fresh repository/Coordinator instance is created over the
same Durable Object storage.

## Validation

Focused storage/restart checks:

```bash
npm run test:durable-storage
```

This runs both the original durable Coordinator contract suite and the
clone-on-access Durable Object repository suite. The latter verifies:

- fresh repository + Coordinator can read a completed request;
- the same idempotency key replays without another executor call;
- request timing/current-segment/attempt history survives restart;
- worker heartbeat mutations survive restart;
- storage correctness does not depend on object-reference aliasing.

## What is intentionally NOT implemented

- **Deployed Durable Object evidence**: the production storage adapter exists,
  but this repository does not yet claim a real Cloudflare deployment/restart
  capture for #103. Treat the tests as contract evidence, not deployed evidence.
- **Real token streaming**: stream cursors/checkpoints are persisted, but token
  chunk streaming itself is outside this module.
- **WebSocket transport**: `DurableCoordinator` remains transport-agnostic;
  message entry points and the pull-model executor path are the execution seam.
