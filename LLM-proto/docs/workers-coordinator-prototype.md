# Workers Coordinator Prototype Gate

This gate moves the simulated Coordinator contract toward the Cloudflare Workers
boundary. `src/workers-coordinator-prototype.ts` models the API request endpoint,
Durable Object single-writer state, WebSocket heartbeat upgrade path, Coordinator
checkpoint storage, p95 fan-out latency, and the transport allowlist that a
Workers prototype must preserve.

`src/workers-coordinator-miniflare-smoke.ts` then runs the same boundary through
Miniflare/workerd: `/api/requests` is dispatched as a real Worker fetch,
registration and checkpoint metadata are persisted through Durable Object
storage, `/workers/:workerId/socket` is opened as a real WebSocket upgrade, and
direct worker-to-worker networking is rejected by the Worker route.
The load-shaped smoke keeps that runtime boundary but drives multiple
customer-like API requests, measures client-side WebSocket heartbeat timing,
simulates worker churn, and recreates the Miniflare Worker against the same
Durable Object persistence root to prove storage survives restart/reload.

`src/workers-coordinator-deployed-smoke.ts` lifts that contract to an
authenticated Wrangler preview or deployed Worker URL. The runner is client
injected so CI can verify the deployed smoke contract without Cloudflare secrets,
while a real browser/WebSocket client can supply fetch latency, heartbeat p95,
edge colo observations, and the deployed Worker report when credentials exist.

The harness intentionally reuses `AdaptiveChunkDispatcher` assignment reports
instead of inventing a second scheduler. This keeps the report fields stable
while validating the Workers-specific boundary.

## Prototype Contract

| Boundary | Prototype expectation |
|---|---|
| API request endpoint | Accepts a request and emits `requestLifecycle` with endpoint, accepted time, planned segment count, prompt tokens, and completed time. |
| Worker registry | Stores registration, heartbeat time, eligibility, and max chunk length in a Durable Object-like single-writer state owner. |
| WebSocket heartbeat path | Reports the upgrade endpoint, processed heartbeat count, fan-out latency samples, and p95 latency. |
| Assignment import | Carries `AdaptiveChunkDispatcher` assignment fields through `assignmentReport.assignments`. |
| Checkpoint relay | Uses Coordinator-owned storage keys and `directWorkerNetworking: false`; no worker-to-worker channel exists. |
| Worker loss | Emits `retryResumeImpact` with lost worker, retry count, resume count, estimated delay, and resume segment. |
| Network boundary | Allows only Coordinator and CDN origins; direct worker-to-worker URLs are rejected by test and reported as rejected. |

## Miniflare Runtime Smoke

The focused runtime smoke uses Miniflare instead of an in-memory Durable Object
stand-in. The test imports an `AdaptiveChunkDispatcher` assignment report, posts
the manifest to `/api/requests`, opens concurrent heartbeat WebSockets for all
registered workers, stores checkpoint relay metadata under Coordinator-owned
Durable Object keys, and records the 403 rejection from `/worker-peer/direct`.

`WorkersCoordinatorMiniflareSmokeReport` includes:

- `runtime`
- `requestLifecycle`
- `durableObjectStorageFields`
- `assignmentReport`
- `checkpointRelay`
- `retryResumeImpact`
- `webSocketHeartbeatPath`
- `directWorkerNetworking`
- `fanoutLatencyMs`
- `bottlenecksToIssue`
- `failureReason`

`WorkersCoordinatorLoadShapedSmokeReport` includes:

- `customerTraffic`
- `clientTiming`
- `restartPersistence`
- `requestReports`
- `directWorkerNetworking`
- `retryResumeImpact`
- `failureReason`

`WorkersCoordinatorDeployedSmokeReport` includes:

- `target`
- `requestLifecycle`
- `browserWebSocketTiming`
- `edgePlacement`
- `directWorkerNetworking`
- `upstreamReport`
- `bottlenecksToIssue`
- `failureReason`

## Report Fields

`WorkersCoordinatorPrototypeReport` includes:

- `requestLifecycle`
- `workerStateBoundary`
- `assignmentReport`
- `checkpointRelay`
- `retryResumeImpact`
- `webSocketHeartbeatPath`
- `directWorkerNetworking`
- `fanoutLatencyMs`
- `bottlenecksToIssue`
- `transport`
- `failureReason`

The gate fails when no worker remains eligible, WebSocket heartbeat p95 fan-out
latency exceeds the configured threshold, or retry/resume impact exceeds the
scale-up threshold.

## Focused Test Command

```bash
cd LLM-proto
npm test -- --run tests/workers-coordinator-prototype.test.ts
npm run test:workers-smoke
npm run test:workers-load-smoke
npm run test:workers-deployed-smoke
```

The full report gate remains:

```bash
cd LLM-proto
npm test -- --run
```

## Next Bottleneck

If the deployed smoke stays under the scale-up gate, the next issue should add
production observability and canary release controls: durable per-request
metrics export, alert thresholds for browser WebSocket p95 and edge placement
variance, and a rollback path that preserves the Coordinator-owned checkpoint
boundary.
