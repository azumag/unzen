# Browser split execution lifecycle

Issue #186 hardens the real two-browser WebGPU verification harness against indefinite waits and resource leaks after failed/manual runs.

## Per-execution cancellation

Each click on **Execute role** creates a fresh `AbortController`. While it is active:

- worker registration and manifest fetch use the signal;
- network artifact fetches use the signal;
- streamed artifact reads observe the signal and cancel their reader;
- Segment 1/standby checkpoint polling uses the signal;
- checkpoint/result POSTs use the signal;
- Stop is enabled and cache clearing is disabled.

Pressing **Stop** aborts the controller. A new run can be started after the current operation has unwound.

### WebGPU/ORT caveat

The harness does not claim that `ort.InferenceSession.run()` can always be forcibly interrupted in ONNX Runtime Web 1.22.0. If Stop is pressed while an ORT WebGPU call is already executing, the UI remains in **Stop requested** state until that call returns or throws. The harness then observes the abort before tensor conversion/network posting and releases the session in `finally`.

Therefore "Stop" means:

1. stop abortable network/poll operations immediately;
2. suppress any checkpoint/result post that has not already begun;
3. wait for a non-abortable in-flight ORT call to return;
4. release the ORT session exactly once;
5. return the UI to a retryable state.

It does not claim GPU preemption that the runtime does not expose.

## Checkpoint wait deadline

Segment 1 and standby no longer poll a missing checkpoint forever. The maximum wait is controlled by the `checkpointWaitMs` URL parameter and defaults to **120000 ms (120 seconds)**.

Examples:

```text
...?role=segment1&run=my-run&checkpointWaitMs=30000
...?role=standby&run=my-run&checkpointWaitMs=30000
```

A missing/wrong run ID therefore ends with a distinct timeout state even if the operator never presses Stop.

## Session ownership

`execution-lifecycle.js` exposes `ownSession(session)`. Segment 0 and Segment 1 wrap every created ORT session and release it from `finally`. The owner is idempotent, so an early release after inference plus the `finally` cleanup still calls the underlying ORT `release()` at most once.

This covers failures in feed construction, `session.run()`, tensor conversion/validation, token decoding, cancellation after WebGPU completion, and Coordinator network errors.

## Manual real-GPU verification

For the next #168 real run, verify all of the following in Chrome Task Manager / DevTools in addition to normal inference evidence:

1. Start Segment 1 with a run ID for which Segment 0 is absent. Press Stop while it is polling. Confirm network polling ceases and Execute becomes available again.
2. Repeat without pressing Stop and use a small `checkpointWaitMs` (for example 5000). Confirm the timeout is surfaced and polling ceases.
3. Start a real segment and press Stop while artifacts are downloading. Confirm the fetch terminates and no checkpoint/result appears for that run.
4. Start a real WebGPU inference and press Stop after `session.run()` begins. Confirm the UI says Stop requested until the ORT call returns, then says Stopped.
5. Repeat failed/stopped executions several times and confirm GPU/process memory returns close to its post-model baseline rather than growing monotonically. This is runtime evidence; CI only proves the release/control-flow contract with fakes.

## Automated evidence

Vitest covers bounded checkpoint waiting, explicit abort, timeout, session release exactly once, try/finally release on inference failure, and abort during streamed artifact reads. The CI browser-harness syntax check continues to parse the actual runner.
