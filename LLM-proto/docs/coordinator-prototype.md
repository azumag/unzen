# Coordinator Prototype Harness

This gate bundles the previous LLM-proto harnesses into a simulated Coordinator
boundary before moving to a Cloudflare Workers prototype. It does not run a real
model. It verifies the request lifecycle, worker registration and heartbeat,
adaptive assignment, Coordinator-mediated checkpoint relay, and retry/resume
report shape that the Workers implementation must preserve.

## Harness Surface

`src/coordinator-prototype.ts` exposes:

| Export | Purpose |
|---|---|
| `createDefaultCoordinatorPrototypeManifest()` | Builds a deterministic request, segment manifest, worker telemetry set, and worker-loss scenario |
| `runCoordinatorPrototype()` | Accepts the API request, filters eligible workers, invokes `AdaptiveChunkDispatcher`, reports checkpoint relay and retry/resume impact |
| `buildCoordinatorPrototypeSegments()` | Creates the small segment manifest used by focused tests and future Workers smoke tests |

The prototype consumes these existing gates:

- `AdaptiveChunkDispatcher` assignment reports for selected chunk length,
  score inputs, load readings, cache hits, and checkpoint transfer estimates.
- `BrowserWorkerRetention` reports for Tier 3 churn. If Tier 3 retention at
  segment end falls below the configured threshold, Tier 3 workers are kept out
  of assignment eligibility.
- The same Coordinator/CDN allowlist transport used by the two-worker harness.
  No worker-to-worker direct networking is introduced.

## Focused Test

Run the Coordinator prototype gate with:

```bash
npm test -- --run tests/coordinator-prototype.test.ts
```

The full LLM-proto gate includes this test:

```bash
npm test -- --run
```

## Report Fields

`CoordinatorPrototypeReport` is the contract to preserve when replacing the
simulated harness with a Cloudflare Workers prototype.

| Field | Requirement |
|---|---|
| `requestLifecycle` | API request acceptance, prompt byte size, assignment count, completion flag, and final segment |
| `workerHeartbeats` | Worker ID, tier, last heartbeat, eligibility, and any retention or heartbeat failure reason |
| `assignments` | `AdaptiveChunkDispatcher` assignment report plus `assignedBy` marker |
| `checkpointRelay` | Actual positive-byte checkpoint transfers only: from-worker, to-worker, segment index, bytes, `via: coordinator`, and `directWorkerNetworking: false` |
| `retryResumeImpact` | Retry count, resume count, affected segments, resumed checkpoint segment, added delay, and failure reason |
| `transport` | Coordinator/CDN allowlist and connections touched by the simulated run |
| `bottlenecksToIssue` | Next issue candidates if the harness passes the scale-up gate |
| `failureReason` | Fail-closed reason when no eligible worker or direct networking appears |

Rolling consecutive assignments stay visible in `assignments` with
`checkpointTransferBytes=0` and `checkpointTransferMs=0`, but they do not add a
`checkpointRelay` row because the checkpoint is not transferred back to the
same worker. Coordinator-owned recovery checkpoint semantics remain unchanged;
the relay list is intentionally limited to transfers that actually consume
relay bytes and transfer time.

Worker-loss selection is strict when `lostWorkerId` is supplied. The harness
selects only an assignment for that worker at or after
`lostAfterAssignmentIndex`; if no such assignment exists, no simulated loss is
reported. When `lostWorkerId` is omitted, `lostAfterAssignmentIndex` retains the
index-only selector used by older fixtures. This keeps an explicit worker ID
from silently turning into evidence for a different worker's loss.

When `lostAfterAssignmentIndex` is supplied by a caller it must be a
non-negative safe integer. Malformed explicit values are rejected before worker
registration, dispatch, or simulated transport connections. Omitting the index
is distinct from passing a negative sentinel: with `lostWorkerId` present and no
index, the selector searches from the first assignment.

The worker-loss selector is a runtime trust boundary. `runCoordinatorPrototype()`
captures `lostWorkerId` and `lostAfterAssignmentIndex` exactly once before worker
registration or dispatch, validates those captured values, and uses the same
snapshot later when building `retryResumeImpact`. An explicitly supplied worker
ID must be a non-empty string; empty, whitespace-only, or non-string values fail
closed rather than being interpreted as omission. Accessor- or Proxy-backed
caller objects therefore cannot validate one selector and switch to another
after dispatch begins.

## Recovery cost estimates

`retryResumeImpact.recoveryCost` is present only for a selected simulated loss.
It independently models a Coordinator-owned checkpoint being sent to a replacement
worker; it never reuses the lost assignment's transfer cost or adds a historical
`checkpointRelay` row. The harness does not select a replacement, perform this
recovery transfer, or verify that the inferred preceding checkpoint was durably
stored. `resumeCount` describes the modeled scenario, not completed recovery.
Original assignment and lifecycle reports still describe the baseline run.

`recoveryCheckpointBytesPerSecond` is an optional positive finite manifest value.
The default is **8 MiB/s**, a synthetic assumption matching the slowest throughput
in the default fixture, not measured replacement throughput or a guaranteed
conservative production bound. Set it explicitly for a different scenario.
Checkpoint size shares the dispatcher's resolved `checkpointBytes` (default 4 MiB).
Both inputs are captured once before dispatch; invalid inputs or an unsafe total
millisecond estimate fail before simulated connections.

For a preceding checkpoint, the recovery transfer estimate is
`max(1, ceil(checkpointBytes / recoveryCheckpointBytesPerSecond * 1000))` ms.
`addedCheckpointDelayMs` adds the separately reported **50 ms** synthetic
`retryOverheadMs`. Thus the default recovery models 500 ms transfer + 50 ms overhead,
including after an original rolling assignment reported 0 bytes / 0 ms.
A first-assignment loss has no preceding checkpoint: recovery bytes/time are zero
and only retry overhead remains. No selected loss retains the existing zero-delay
report without a `recoveryCost` object.

The recovery object records `checkpointBytes`, `checkpointTransferMs`,
`bytesPerSecond`, `source` (`prototype-configured-rate` or `prototype-default-rate`),
`retryOverheadMs`, `via: coordinator`, and `evidence: estimated`. These values
exclude recomputation, model downloads, loss detection, and real storage read/egress
measurements. The existing >500 ms checkpoint budget flag now reflects this estimate;
it is not production latency evidence. Future actual retry assignment or storage
instrumentation must supply separately identified evidence without double-counting
an end-to-end observed transfer. Worker-to-worker networking remains disallowed.

Run focused regressions with:

```bash
npm test -- tests/coordinator-recovery-cost.test.ts tests/coordinator-prototype.test.ts tests/coordinator-worker-loss-selector.test.ts
```

## Cloudflare Workers Prototype Handoff

If this harness passes and the report stays inside the latency and churn
budgets, the next issue should implement a minimal Workers-side prototype with:

1. An API request endpoint that creates the same `requestLifecycle` report.
2. A worker registration and heartbeat endpoint backed by Durable Objects or an
   equivalent single-writer state boundary.
3. Assignment generation from `AdaptiveChunkDispatcher` report fields.
4. Checkpoint relay through Coordinator-owned storage or message channels only.
5. Resume/retry reporting that keeps `retryResumeImpact` compatible with this
   harness.

File the next bottleneck as a separate issue if the Workers prototype exposes:

- Durable Object fan-out or WebSocket coordination latency above the checkpoint
  relay budget;
- Tier 3 churn below the configured assignment threshold;
- checkpoint payload transfer above the measurement gate;
- a need for worker-to-worker networking, which should remain rejected by
  policy rather than treated as an optimization.
