# Workers Coordinator Prototype Gate

This gate moves the simulated Coordinator contract toward the Cloudflare Workers
boundary without requiring a deployed Worker. `src/workers-coordinator-prototype.ts`
models the API request endpoint, Durable Object single-writer state, Coordinator
checkpoint storage, and the transport allowlist that a Workers prototype must
preserve.

The harness intentionally reuses `AdaptiveChunkDispatcher` assignment reports
instead of inventing a second scheduler. This keeps the report fields stable
while validating the Workers-specific boundary.

## Prototype Contract

| Boundary | Prototype expectation |
|---|---|
| API request endpoint | Accepts a request and emits `requestLifecycle` with endpoint, accepted time, planned segment count, prompt tokens, and completed time. |
| Worker registry | Stores registration, heartbeat time, eligibility, and max chunk length in a Durable Object-like single-writer state owner. |
| Assignment import | Carries `AdaptiveChunkDispatcher` assignment fields through `assignmentReport.assignments`. |
| Checkpoint relay | Uses Coordinator-owned storage keys and `directWorkerNetworking: false`; no worker-to-worker channel exists. |
| Worker loss | Emits `retryResumeImpact` with lost worker, retry count, resume count, estimated delay, and resume segment. |
| Network boundary | Allows only Coordinator and CDN origins; direct worker-to-worker URLs are rejected by test. |

## Report Fields

`WorkersCoordinatorPrototypeReport` includes:

- `requestLifecycle`
- `workerStateBoundary`
- `assignmentReport`
- `checkpointRelay`
- `retryResumeImpact`
- `fanoutLatencyMs`
- `transport`
- `failureReason`

The gate fails when no worker remains eligible, fan-out latency exceeds the
configured threshold, or retry/resume impact exceeds the scale-up threshold.

## Focused Test Command

```bash
cd LLM-proto
npm test -- --run tests/workers-coordinator-prototype.test.ts
```

The full report gate remains:

```bash
cd LLM-proto
npm test -- --run
```

## Next Bottleneck

If this Workers Coordinator prototype stays under the scale-up gate, the next
issue should replace the in-memory Durable Object simulation with a minimal
Wrangler/Miniflare Worker test that opens a real WebSocket upgrade path,
persists checkpoint metadata in Durable Object storage, and measures p95 fan-out
latency under concurrent heartbeat churn.
