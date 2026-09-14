# Durable recovery command option ownership

`beginDurableRecovery()` treats its `DurableRecoveryCommandOptions` argument as a runtime trust boundary rather than relying on the TypeScript `readonly` surface.

For every non-missing, non-terminal recovery attempt, the command reads the consumed option fields exactly once before the first recovery ownership mutation:

- `ownerId`
- `now`
- `ownershipTtlMs`
- `maxRetries`
- `manifestDigest`

Each captured value is validated immediately, before any recovery ownership or request mutation. `ownerId` and `manifestDigest` must be non-empty runtime strings; `now` and `ownershipTtlMs` must be non-negative finite numbers; and `maxRetries` must be a non-negative safe integer. The derived `now + ownershipTtlMs` expiry is also computed once and must remain finite, so individually finite values cannot overflow into an immortal `Infinity` ownership record. Zero remains valid for the numeric controls where the existing coordinator contract permits it. Diagnostics test the runtime type directly and do not stringify malformed values such as `Symbol`.

The validated owned snapshot, including the derived expiry, is then reused for recovery ownership creation, the ownership claim time, planner inputs, claim release, and terminal timestamps. Getter- or Proxy-backed inputs therefore cannot switch owner identity or time coordinates between those steps, and type-asserted/decoded runtime values cannot persist malformed recovery ownership before failing.

The existing early-return behavior is intentionally preserved: missing requests and already-terminal requests return before recovery options are read or validated. This keeps a read-only scan from evaluating caller-owned option accessors when no recovery mutation can occur.

This contract is coordinator recovery hardening only. It does not constitute new real-model, WebGPU, multi-browser relay, worker-loss resume, or production deployment evidence for #167/#158.
