# Durable recovery runner option ownership

`runDurableRecovery()` can span multiple polling waits, a resume callback, recovery-ownership renewal timer callbacks, and final cleanup. Its caller-owned options are therefore captured into runner-owned values once before that asynchronous lifecycle begins.

The owned runner configuration includes:

- recovery `ownerId`
- ownership TTL and renewal interval
- polling interval
- retry budget and manifest digest
- clock and sleep callbacks
- abort signal
- resume callback

All later `beginDurableRecovery()` calls, bounded waits, renewal claims, resume delivery, and final ownership release use that same snapshot. Getter- or Proxy-backed options cannot switch owner identity, timing policy, abort signal, or callback behavior after recovery has started.

The optional abort signal is also checked at the runner boundary before repository planning or ownership acquisition. A supplied signal must be an AbortSignal-compatible object with a boolean `aborted` state and callable `addEventListener` / `removeEventListener` methods. This keeps a malformed type-asserted or decoded value from reaching `forwardAbort()` after a `resume-claimed` decision, where throwing before the resume cleanup scope could otherwise leave durable recovery ownership live until its TTL expired. Native signals and structural AbortSignal-compatible test/runtime adapters remain supported.

A structural signal can still be caller-controlled after entry validation. The resume subscription therefore lives inside the same `try/finally` scope that releases recovery ownership, and subscription failure performs best-effort listener removal before propagating a stable `TypeError`. Even a Proxy/getter that changes its listener surface after validation cannot strand a recovery claim.

The runner's default bounded wait applies the same rule to peer-owner, live-lease, and short state-change waits. Signal state is live-read as a boolean, listener removal is best-effort after the timer is cleared, and subscription or post-subscription state-read failures reject the wait deterministically. The existing check → subscribe → re-check cancellation ordering remains in place, but a hostile structural signal cannot stop the wait promise from settling by throwing during cleanup.

This complements the command-level option ownership boundary: the command owns the values for one recovery decision, while the runner owns the values for the entire asynchronous recovery lifecycle.

This is coordinator recovery trust-boundary hardening only. It is not new real-model, WebGPU, multi-browser relay, worker-loss resume, or production deployment evidence for #167/#158.
