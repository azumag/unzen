# Browser Worker Retention Measurement Gate

This milestone turns the PLAN.md browser-abandonment risk into an executable
retention and churn report before a pilot site or real browser/WebGPU campaign
is started.

The harness still does not run a real model. It consumes sampled worker session
durations and segment-abandonment events, then reports whether normal browser
visitors can safely participate as Tier 3 burst workers without overwhelming
checkpoint resume and retry budgets.

## Harness

`src/browser-worker-retention.ts` exposes:

| API | Purpose |
|---|---|
| `createDefaultBrowserRetentionManifest()` | Builds a default mixed Tier 1 / Tier 2 / Tier 3 session sample set and scale-up thresholds |
| `measureBrowserWorkerRetention()` | Reports duration distribution, retention curve, early-abandon rate, retry/resume impact, tier breakdown, telemetry comparison, and failure reason |

The default manifest uses long-lived Tier 1/2 sessions plus ordinary Tier 3 web
visitor sessions. It includes one Tier 3 segment abandonment so the report can
exercise checkpoint resume accounting without failing the default gate.

## Report Fields

`measureBrowserWorkerRetention()` returns:

| Field | Purpose |
|---|---|
| `durationDistribution` | Session duration min / p50 / p95 / max in milliseconds |
| `retentionCurve` | Retained count and rate at each configured measurement window |
| `earlyAbandonRate` | Share of sessions shorter than the configured early-abandon threshold |
| `tierBreakdown` | Separate Tier 1, Tier 2, and Tier 3 p50 / p95 / early-abandon / segment-retention values |
| `retryResumeImpact` | Segment-abandonment count, retry count, resume count, affected segments, and added checkpoint delay |
| `adaptiveTelemetryComparison` | Observed median uptime, failure rate, and heartbeat jitter compared with `AdaptiveChunkDispatcher` assumptions |
| `failureReason` | Scale-up blocker such as early abandonment, low segment retention, or excessive resume delay |

## Focused Test Command

```bash
cd LLM-proto
npm test -- --run tests/browser-worker-retention.test.ts
```

The full regression bar remains:

```bash
cd LLM-proto
npm test -- --run
npx tsc -p tsconfig.json --noEmit
```

## Manual Browser Measurement Path

Run this only after the simulated retention report passes:

1. Instrument the pilot site worker iframe to emit session start, heartbeat,
   segment assignment, segment completion, checkpoint resume, retry, and unload
   events.
2. Keep Tier 1/2 long-lived workers and Tier 3 ordinary visitors separate in
   the report; do not average them into one availability number.
3. Build the same `sessionDurationMs`, `heartbeatJitterMs`, and
   `disconnectedDuringSegment` samples that the harness consumes.
4. Compare the observed p50 / p95 session duration, early-abandon rate,
   retention-at-segment-end, and retry/resume delay with this gate.
5. Feed the observed median uptime, failure rate, and heartbeat jitter back into
   `AdaptiveChunkDispatcher` telemetry defaults before increasing chunk size.

## Follow-Up Issue Triggers

Open the next issue before advancing when:

- Tier 3 early abandonment exceeds the configured gate;
- retention at one segment duration falls below the assignment threshold;
- checkpoint resume and retry delay exceeds the request latency budget;
- observed heartbeat jitter or failure rate is worse than the dispatcher
  baseline;
- Tier 3 sessions only pass when they receive rolling assignments or
  worker-to-worker networking.

Those bottlenecks should become separate issues because the fix may require
smaller Tier 3 chunks, stricter Tier 3 eligibility, longer checkpoint TTLs,
lighter onboarding, pilot-site UX changes, or a Tier 1/2-only execution mode.
