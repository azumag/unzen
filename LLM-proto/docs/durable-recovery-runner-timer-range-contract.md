# Durable recovery runner host-timer range

`runDurableRecovery()` owns its caller-supplied options before the recovery lifecycle crosses an async boundary. Two controls can directly bound host timers in that lifecycle:

- `ownershipRenewIntervalMs` controls the recovery-ownership `setInterval()` cadence;
- `pollIntervalMs` bounds default `setTimeout()` sleeps while waiting for a peer owner, active lease, or state change.

Both values must be finite, non-negative numbers no greater than `2147483647ms` (`MAX_TIMER_DELAY_MS`). Invalid or larger values fail before repository access, ownership claims, sleeps, or renewal timer registration. Explicit zero remains accepted; the existing renewal path still normalizes its effective cadence to at least 1ms.

`ownershipTtlMs` remains a durable expiry/deadline value rather than a host-timer delay and is therefore not capped solely because it may exceed the host timer range. With a valid renewal interval, the effective renewal timer remains bounded even when the ownership TTL is larger. Poll waits are likewise bounded by the already-validated `pollIntervalMs` before reaching the default host timer.

The public `DurableCoordinator` separately validates the corresponding constructor controls before core state exists. The direct runner check is still required because `runDurableRecovery()` is exported and can be invoked independently in tests/integration code.

This is host-side reliability hardening for #874. It does not add physical WebGPU, real multi-browser relay, real Llama q4 artifact, production deployment, credential, billing, or operator-authorization evidence.
