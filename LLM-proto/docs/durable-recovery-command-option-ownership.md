# Durable recovery command option ownership

`beginDurableRecovery()` treats its `DurableRecoveryCommandOptions` argument as a runtime trust boundary rather than relying on the TypeScript `readonly` surface.

For every non-missing, non-terminal recovery attempt, the command reads the consumed option fields exactly once before the first recovery ownership mutation:

- `ownerId`
- `now`
- `ownershipTtlMs`
- `maxRetries`
- `manifestDigest`

The owned snapshot is then reused for recovery ownership creation, the ownership claim time, planner inputs, claim release, and terminal timestamps. Getter- or Proxy-backed inputs therefore cannot switch owner identity or time coordinates between those steps.

The existing early-return behavior is intentionally preserved: missing requests and already-terminal requests return before recovery options are read. This keeps a read-only scan from evaluating caller-owned option accessors when no recovery mutation can occur.

This contract is coordinator recovery hardening only. It does not constitute new real-model, WebGPU, multi-browser relay, worker-loss resume, or production deployment evidence for #167/#158.
