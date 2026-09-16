# Browser checkpoint wait lifecycle

The real browser split harness treats checkpoint polling delays as runtime data. JavaScript host timers do not preserve arbitrary numeric delays, so malformed or oversized values must not be allowed to silently turn into immediate or truncated timers.

## Timeout budget identity

`waitForCheckpointBounded()` requires `timeoutMs` to be a positive JavaScript safe integer before the first checkpoint fetch or sleep. This prevents fractional, non-finite, coerced, or unsafe timeout values from being accepted as a deadline and only failing later when a residual wait reaches the timer helper.

The absolute timeout budget is intentionally **not** capped to the host timer ceiling. A valid safe-integer timeout may exceed `2_147_483_647` milliseconds because the wait is represented as an absolute deadline and is advanced through bounded polling intervals rather than one host timer.

## Timer-backed delay contract

`delayWithSignal(ms, signal)` accepts only non-negative safe integers up to `2_147_483_647` milliseconds, the host timer ceiling used by the runtime. Validation happens before timer or abort-listener registration. `0ms` remains valid for callers that intentionally yield through the event loop.

`waitForCheckpointBounded()` applies the same host-timer domain to `pollIntervalMs`, except that polling requires a strictly positive interval. Invalid polling intervals are rejected before the first checkpoint fetch.

## Abort race closure

A checkpoint delay checks `signal.aborted` before creating the timer, installs its abort listener, and then re-checks `signal.aborted`. This closes the check-then-listen window where an AbortSignal could previously flip after the first check but before listener installation and leave a cancelled wait sleeping until the timer fired.

Abort cleanup is idempotent: the timer is cleared, the listener is removed, and the promise rejects with `AbortError` at most once.

## Evidence boundary

This contract hardens the browser-side lifecycle used by the multi-browser/WebGPU path. It does not by itself provide new evidence for real Llama-3.2-1B q4 artifact materialization, physical WebGPU working-set, observed Coordinator checkpoint relay/latency, or worker-loss resume acceptance tracked by #167.
