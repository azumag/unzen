# Durable Coordinator (Issue #103)

`DurableCoordinator` (`src/durable-coordinator.ts`) is the durable execution
path for the Coordinator role, fixing the prototype's process-local state,
`req-1` request IDs, silent worker overwrites, and non-aborting timeouts.
The legacy `Coordinator` / `Pipeline` / `WorkerPool` / `CheckpointStore`
remain as the contract-tested prototype; this module is the #103 deliverable.

Status: `contract-tested` — behavior is verified by the in-memory repository +
durable Coordinator test suite. A production storage adapter does not exist yet
(the repository interface is Durable-Object shaped so it can be backed by Durable
Objects), so this is not production-durable evidence.

## Modules

| Module | File | Role |
|---|---|---|
| IDs | `src/ids.ts` | UUIDv7 + monotonic-suffix IDs for request/attempt/lease/worker-generation |
| Errors | `src/errors.ts` | Structured error taxonomy, retry policy, isolation classification |
| State machine | `src/request-state-machine.ts` | Validated transition graph (accepted→queued→leased→running→completed + cancelled/retry-wait/failed) |
| Durable repository | `src/durable-repository.ts` | `DurableRepository` interface + `InMemoryRepository` (explicit storage boundaries) |
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
  repository (`idempotencyMappings`); a duplicate submission returns the
  existing request's status/result and **never double-executes**.
- Request / attempt / lease IDs are separate namespaces.

## Storage boundaries

The repository splits state into dedicated buckets so a production adapter can
distribute them (request Durable Object, worker Durable Object, checkpoint
payload store, ...):

| Boundary | Repository methods |
|---|---|
| request state | `createRequest` / `getRequest` / `transitionStage` (CAS) |
| idempotency | `putIdempotencyMapping` / `getIdempotencyMapping` |
| attempt history | `appendAttempt` / `listAttempts` / `updateAttempt` |
| worker registration / generation / lease | `putWorker` / `getWorker` / `deleteWorker` / `listWorkers` |
| checkpoint metadata / payload locator | `putCheckpoint` / `getCheckpoint` / `collectExpiredCheckpoints` |
| streaming cursor | `putStreamCursor` / `getStreamCursor` |
| completion / result metadata | `commitCompletion` (CAS) / `getResult` |
| cancellation state | `putCancellation` / `getCancellation` |

Completion is committed **exactly once** via compare-and-set
(`commitCompletion`): a duplicate completion is ignored (`duplicate`) and a
completion arriving in the wrong stage is rejected (`conflict`) — never
overwritten.

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
- `queued → failed` and `retry-wait → failed` were added to the issue's minimal
  graph so a request that can never be scheduled (or whose deadline expires
  during backoff) fails instead of hanging in `queued`.
- `running → queued` was added for multi-segment runs: after a non-final
  segment commits its checkpoint, the request returns to the scheduling queue
  for the next segment's lease.
- All transitions are validated; late updates from terminal states are rejected.

## Assignment identity / result acceptance

Every assignment carries `requestId, attemptId, leaseId, workerId,
workerGeneration, segmentIndex, modelManifestDigest`. Results, failures, and
checkpoints echo that identity. The Coordinator commits **only** when the
identity matches the active lease exactly (`LeaseManager.match`): a mismatched
attempt/lease/worker/generation/segment, an expired lease, or a request with no
active lease is suppressed (`identity-mismatch`) and never committed. The
worker generation is then isolated (revoked + leases reclaimed).

## Checkpoint integrity

Checkpoints travel as `CheckpointEnvelope` values bound to producer identity,
worker generation, model manifest digest, format version, payload length +
SHA-256 digest, createdAt/TTL, and optional previous-checkpoint digest.
`validateCheckpointEnvelope` runs at the Coordinator boundary **before**
storage/relay; a checkpoint from another request or a different model revision
is never saved. Expired checkpoints are collected by a periodic cleanup and on
request terminalization.

## Worker registration / connection generation

- One generation per transport connection / auth session.
- Re-registration of the same `workerId` on a **new** connection revokes the
  old generation and reclaims its leases (reconnect = new generation).
- Re-registration on the **same** connection is a capability refresh.
- Heartbeats alone never revive a revoked generation; a heartbeat from an
  unknown worker or a stale/revoked generation throws a structured error.
- Capability (VRAM ≥ manifest `runtimeRequirements.minimumVramMB`) is validated
  at registration.

## Error taxonomy

`ErrorCode` separates worker health from task failure. Task-level failures
(`invalid-input`, `unsupported-request`, `context-overflow`) never disconnect a
healthy worker. Worker/transport/protocol/identity/integrity failures
(`worker-disconnected`, `heartbeat-timeout`, `transport-transient`,
`runtime-transient`, `protocol-violation`, `result-identity-mismatch`,
`checkpoint-integrity-mismatch`, `integrity-security-failure`,
`stale-generation`, `segment-timeout`, ...) are isolatable.

Retry policy keyed by code: retryable = worker-health + transient +
model-preparation + segment-timeout; everything else (task-level, cancellation,
deadline, protocol/security) is not retried.

## Cancellation / timeout

- Per-request `AbortController`; the caller's signal and a request deadline
  both abort it, and the signal is handed to `SegmentExecutor.execute(..., { signal })`.
- `withAbortableTimeout` aborts the underlying work on a per-segment timeout
  (rejects `SegmentTimeoutError`) and propagates caller cancellation (rejects
  AbortError → `UnzenCancelledError`). Cancel/timeout never trigger fallback or
  retry (mirrors the `core` cancellation contract, issue #106).
- `cancel(requestId)` records the cancellation with a deadline and force-
  acknowledges it once the executor settles.

## Streaming-cancel / failure / fallback policy

The stream cursor records the last committed segment index. Chunks are
delivered in segment order; a checkpoint is the resume boundary.

- **Cancel**: the remaining stream is aborted, the request moves to
  `cancelled`, and no further chunks or checkpoints are relayed. Late chunks
  arriving after cancel are suppressed (`no-active-lease`). Cancellation is a
  terminal state and never triggers retry or fallback.
- **Failure**: the stream is terminated at the last committed cursor.
  Retryable failures (`worker-disconnected`, `transport/runtime-transient`,
  `segment-timeout`, ...) resume from the checkpoint at that cursor, bounded by
  `maxRetries`. Non-retryable failures (invalid input, protocol/identity/
  integrity violations, deadline) fail the request; the stream is closed.
- **Fallback**: there is no implicit server-side fallback in the Coordinator.
  A user cancellation or a non-retryable failure is surfaced to the API caller
  as-is. Fallback is only the bounded retry-on-another-worker path described
  above, and it is keyed strictly by the error-code retry policy.

## Status / result lookup

`getStatus(requestId)` returns the stage, attempt history, retry count, latency
(startedAt/completedAt), and the committed result. `getResult(requestId)`
returns the stored `InferenceResult`. Suppressed (late/duplicate/stale)
deliveries are recorded on the Coordinator for observability.

## What is intentionally NOT implemented

- **Production storage adapter**: the repository interface is the deliverable;
  a Durable-Object / R2 adapter is a follow-up. In-memory state survives only
  while the process (or the shared repository instance) lives.
- **Real streaming tokens**: the stream cursor boundary exists and is
  persisted, but token-chunk streaming is not; the checkpoint is the unit of
  resume.
- **WebSocket transport**: `DurableCoordinator` is transport-agnostic like the
  prototype; `handleWorkerResult`/`handleWorkerFailure` are the message-based
  entry points and the pull-model executor path is the primary driver.
