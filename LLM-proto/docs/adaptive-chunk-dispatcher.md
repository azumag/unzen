# Adaptive Chunk Dispatcher Specification

## Purpose

This document defines the second LLM-proto scheduling milestone after the fixed
[2B / 2-worker prototype](./2b-two-worker-prototype.md).

The first prototype intentionally fixes the model split to two contiguous
segments. The next milestone makes chunk size and dispatch order adaptive:
the Coordinator should assign longer contiguous chunks to workers that can hold
them safely, keep browser CPU/GPU pressure near the user-visible budget, and
prefer long-lived workers for consecutive chunk loading.

## Scheduling Goals

| Goal | Requirement |
|---|---|
| User device impact | Keep additional PC load inside a 2-3% sustained budget whenever the browser can measure it. |
| Chunk sizing | Change contiguous chunk size based on worker capacity, measured throughput, cache state, and current load. |
| Consecutive loading | Let long-lived workers process chunk N then preload/process chunk N+1 when that is faster than moving the checkpoint. |
| Dispatcher ordering | Assign the next chunk using uptime, spare capacity, heartbeat quality, cache hits, and recent failures. |
| Safety boundary | Keep all assignments and checkpoints Coordinator-mediated; no worker-to-worker direct channel is introduced. |

The 2-3% load target is a control objective, not a hard guarantee. Browser APIs
do not expose a single reliable cross-platform "PC load" metric. The
Coordinator therefore treats load as a measured score from available signals and
falls back to conservative one-chunk assignments when confidence is low.

## Worker Telemetry

Workers must report these values at registration and on each heartbeat:

| Field | Source | Usage |
|---|---|---|
| `uptimeMs` | Worker runtime clock | Prefer stable workers for longer consecutive chunks. |
| `vramFreeMB` | WebGPU adapter limits plus local allocator estimate | Cap maximum model layers resident on the device. |
| `gpuBusyRatio` | Worker-side rolling execution/idle ratio | Throttle assignments when the device is near the 2-3% budget. |
| `cpuBusyRatio` | Browser performance sampling when available | Detect CPU fallback or serialization pressure. |
| `cacheHits` | IndexedDB segment inventory | Prefer already-loaded or cached chunks to avoid reload latency. |
| `tokensPerSecond` | Recent successful span executions | Estimate whether a larger chunk improves total latency. |
| `checkpointBytesPerSecond` | Recent checkpoint relay timing | Decide whether avoiding a checkpoint transfer is worth a larger chunk. |
| `failureRate` | Coordinator rolling window | Penalize workers that recently disconnected or timed out. |

Telemetry must be treated as untrusted input. It can guide scheduling, but the
Coordinator still enforces maximum span size, heartbeat timeouts, allowlisted
model artifacts, and retry limits.

## Adaptive Chunk Size

A chunk is a contiguous set of model segments assigned to one worker. For a
worker `w`, the Coordinator computes:

```text
maxResidentSegments =
  floor(min(vramFreeMB, configuredVramLimitMB) / segmentEstimatedVramMB)

loadBudgetScale =
  1.0 when gpuBusyRatio and cpuBusyRatio are within the target budget
  0.5 when either value is near the budget ceiling
  0.0 when either value exceeds the budget or is unknown for a Tier 3 worker

stabilityScale =
  1.0 for long-lived workers with clean heartbeats
  0.5 for new workers or workers with minor heartbeat jitter
  0.0 for recently failed workers

targetChunkSegments =
  clamp(1, maxResidentSegments, floor(maxResidentSegments * loadBudgetScale * stabilityScale))
```

The Coordinator may temporarily choose a smaller chunk than
`targetChunkSegments` when the next chunk is latency-critical or when another
worker already has the next segment cached.

## Dispatch Score

For each pending chunk start index, eligible workers are scored:

```text
score =
  capacityScore(vramFreeMB, targetChunkSegments)
  + stabilityScore(uptimeMs, heartbeatJitterMs, failureRate)
  + cacheScore(cachedSegmentsAroundStart)
  + throughputScore(tokensPerSecond)
  + transferAvoidanceScore(checkpointBytesPerSecond, chunkLength)
  - loadPenalty(gpuBusyRatio, cpuBusyRatio)
  - freshnessPenalty(lastAssignmentAgeMs)
```

The dispatcher picks the highest score that can cover the next contiguous
segment. It must emit the chosen score inputs into the run report so that bad
routing decisions can be debugged after a failed or slow run.

## Consecutive Chunk Loading

Long-lived Tier 1 and Tier 2 workers can receive a rolling assignment:

```text
chunk 1 assigned -> worker keeps segment weights resident
chunk 1 result -> Coordinator validates checkpoint
chunk 2 preloaded or already resident -> worker continues without cold load
```

This is allowed only when all of these are true:

- The worker has enough free VRAM for the next chunk's weights and activations.
- The worker's measured load remains inside the configured budget.
- The next chunk is contiguous with the completed chunk.
- The run can still resume from the previous Coordinator checkpoint if the
  worker disappears.
- The assignment does not starve other queued requests beyond the configured
  fairness window.

Tier 3 workers should not receive rolling assignments by default. They may be
used for one short chunk when stable Tier 1/2 capacity is unavailable.

## Backpressure And Throttling

The Coordinator must shrink or pause assignments when:

- Reported CPU/GPU load exceeds the 2-3% sustained target.
- Heartbeat jitter increases during execution.
- Checkpoint relay time dominates segment execution time.
- The browser reports battery saver mode, thermal throttling, or AC power loss
  when such signals are available.

Backpressure decisions are part of the scheduling contract. A worker that is
otherwise powerful but currently busy should receive a smaller chunk or no chunk
until its load score recovers.

## Acceptance Criteria

The adaptive dispatcher milestone is complete when all of the following are
true:

- Worker registration and heartbeat messages carry uptime, load, cache, and
  throughput telemetry.
- The Coordinator can compute a chunk length per worker instead of using a
  fixed segment count.
- A long-lived worker can process two consecutive contiguous chunks without a
  cold reload between them.
- A high-load worker is throttled to a smaller chunk or skipped.
- A newly joined or short-lived Tier 3 worker does not receive a rolling
  consecutive assignment by default.
- The run report records the selected chunk length, dispatch score inputs,
  load readings, cache-hit state, retry count, and checkpoint transfer timing.
- No scheduling path introduces worker-to-worker networking or bypasses the
  Coordinator checkpoint boundary.

## Relationship To Existing Designs

- `docs/2b-two-worker-prototype.md` remains the fixed first runnable milestone.
- `PLAN.md` remains the long-term architecture and safety policy.
- `src/span-router.ts` is the current fixed-capacity routing baseline. This
  specification defines the telemetry and scoring requirements needed before it
  becomes an adaptive dispatcher.
