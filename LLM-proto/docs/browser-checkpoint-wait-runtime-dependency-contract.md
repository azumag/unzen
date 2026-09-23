# Browser checkpoint wait runtime dependency contract

`browser-harness/webgpu-2b-split/execution-lifecycle.js::waitForCheckpointBounded()` is a runtime trust boundary around Coordinator checkpoint polling. Programmatic callers can bypass TypeScript and may inject malformed values, so callable dependencies and cancellation state are validated before the wait performs caller-owned or network work.

## Preflight ordering

For each invocation the wait now resolves its runtime envelope in this order:

1. validate `timeoutMs` as a positive safe integer;
2. validate `pollIntervalMs` as a positive host-timer-safe integer;
3. require `fetchCheckpoint` to be a function;
4. require `readCheckpointResponse` to be a function;
5. require `sleep` to be a function;
6. reject an already-aborted or malformed `signal`;
7. read and validate the first `now()` sample;
8. only then call `fetchCheckpoint()`.

This ordering means a malformed fetch/response-reader/sleep dependency cannot trigger a clock callback or Coordinator request first. An initially aborted signal likewise does not invoke the clock or fetch path.

The resolved function references are then used for the whole wait. Existing checks around every asynchronous fetch boundary remain in place, so cancellation that happens after the initial preflight still stops polling. A successful non-404 response is decoded only through the snapshotted `readCheckpointResponse` dependency; `waitForCheckpointBounded()` no longer owns an unbounded `Response.json()` fallback.

## Preserved semantics

- `timeoutMs` remains an absolute comparison budget and may exceed the host timer ceiling as long as it is a positive safe integer.
- `pollIntervalMs` remains bounded by `MAX_HOST_TIMER_DELAY_MS` because it can reach `setTimeout()` through `delayWithSignal()`.
- malformed or throwing later clock samples still fail before another sleep is scheduled.
- a successful non-404 checkpoint response is returned without sleeping after the supplied reader completes.
- `delayWithSignal()` keeps its independent host-timer and AbortSignal lifecycle contract.

## Evidence boundary

This is browser-harness runtime/reliability hardening for #167. It does not constitute new real `Llama-3.2-1B-Instruct` q4 materialization evidence, physical WebGPU working-set evidence, real multi-browser relay/latency evidence, or worker-loss/resume evidence. It does not require production deployment, credentials, billing, or external service changes.
