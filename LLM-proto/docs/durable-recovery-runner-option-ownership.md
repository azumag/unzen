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

This complements the command-level option ownership boundary: the command owns the values for one recovery decision, while the runner owns the values for the entire asynchronous recovery lifecycle.

This is coordinator recovery trust-boundary hardening only. It is not new real-model, WebGPU, multi-browser relay, worker-loss resume, or production deployment evidence for #167/#158.
