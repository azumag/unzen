# Browser checkpoint wait lifecycle

The real browser split harness treats checkpoint polling delays as runtime data. JavaScript host timers do not preserve arbitrary numeric delays, so malformed or oversized values must not be allowed to silently turn into immediate or truncated timers.

## Timeout budget identity

`waitForCheckpointBounded()` requires `timeoutMs` to be a positive JavaScript safe integer before the first checkpoint fetch or sleep. This prevents fractional, non-finite, coerced, or unsafe timeout values from being accepted as a deadline and only failing later when a residual wait reaches the timer helper.

The absolute timeout budget is intentionally **not** capped to the host timer ceiling. A valid safe-integer timeout may exceed `2_147_483_647` milliseconds because the wait is advanced through bounded polling intervals rather than one host timer. Elapsed time is measured relative to the captured start time instead of computing `Date.now() + timeoutMs`; this avoids losing millisecond identity when a long but valid timeout plus an epoch timestamp would cross `Number.MAX_SAFE_INTEGER`.

## Checkpoint clock contract

The injected `now()` function is a runtime trust boundary, not a typed-only convenience. Every clock sample used by `waitForCheckpointBounded()` must be a non-negative JavaScript safe integer. The initial sample is validated before the first checkpoint fetch or sleep, so malformed values cannot start a polling lifecycle. Later samples are validated before residual timeout values are passed to the sleep/timer helper, preventing `NaN`, infinities, fractional values, runtime strings, or unsafe integers from being reinterpreted as timer delays.

Accepted samples must also be monotonic non-decreasing within one wait. A later sample that is smaller than the previous accepted sample is rejected before it can enlarge the remaining timeout budget or allow another checkpoint fetch. Equal timestamps remain valid. The wait does not synthesize, clamp, or repair a regressing caller-owned clock; it fails closed instead.

If the caller-owned clock throws, that original exception remains the root error. The wait does not wrap it as a timer validation or timeout failure. This keeps clock failures distinguishable from `CheckpointWaitTimeoutError` and host-timer domain violations.

The default clock remains `Date.now()`. Callers may inject another millisecond clock, but every accepted sample must satisfy the same safe-integer and non-decreasing contract.

## Timer-backed delay contract

`delayWithSignal(ms, signal)` accepts only non-negative safe integers up to `2_147_483_647` milliseconds, the host timer ceiling used by the runtime. Validation happens before timer or abort-listener registration. `0ms` remains valid for callers that intentionally yield through the event loop.

`waitForCheckpointBounded()` applies the same host-timer domain to `pollIntervalMs`, except that polling requires a strictly positive interval. Invalid polling intervals are rejected before the first checkpoint fetch.

## Abort race and cleanup containment

A checkpoint delay checks `signal.aborted` before creating the timer, installs its abort listener, and then re-checks `signal.aborted`. This closes the check-then-listen window where an AbortSignal could otherwise flip after the first check but before listener installation and leave a cancelled wait sleeping until the timer fired.

Caller-owned signal state and listener methods are treated as a trust boundary. The `aborted` state must remain boolean and readable. Subscription or post-subscription state failure rejects the delay deterministically after clearing its timer, while listener removal is best-effort. A throwing `removeEventListener()` therefore cannot prevent resolve/reject or leave the delay pending.

The streamed artifact reader follows the same lifecycle. Once `getReader()` has acquired the body lock, signal subscription and the post-subscription state check run inside the reader's cancellation/release scope. If setup fails, cancellation and `releaseLock()` are attempted before the error escapes. Listener removal and reader release are independent best-effort cleanup steps, so a cleanup hook cannot replace a successful byte result or an earlier integrity/cancellation failure.

## Evidence boundary

This contract hardens the browser-side lifecycle used by the multi-browser/WebGPU path. It does not by itself provide new evidence for real Llama-3.2-1B q4 artifact materialization, physical WebGPU working-set, observed Coordinator checkpoint relay/latency, or worker-loss resume acceptance tracked by #167. It also does not change persisted legacy deadline policy in #877 or production deployment work in #158.
