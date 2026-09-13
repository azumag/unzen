# Durable `ExecutionFailure` runtime-envelope contract

`DurableCoordinator.handleWorkerFailure()` is a transport-facing boundary. The TypeScript `ExecutionFailure` interface is compile-time documentation only; values arriving from a browser worker or transport must be treated as untrusted runtime data.

Before cancellation lookup, lease matching, attempt mutation, lease reclaim, suppression recording, or worker isolation, the coordinator validates the complete failure envelope used by those operations:

- the failure and `identity` containers must be non-null, non-array objects;
- `requestId`, `attemptId`, `leaseId`, `workerId`, and `workerGeneration` must be non-empty runtime strings;
- `segmentIndex` must be a non-negative safe integer;
- `code` must be a runtime string in the closed `ErrorCode` taxonomy (`classifyErrorCode` is authoritative);
- `message` must be a runtime string before it can be propagated or logged.

Malformed envelopes fail closed with `ErrorCode.ProtocolViolation`. Rejection happens before any durable request, active lease, attempt, suppression, or worker-health mutation, including for coercion-unsafe values such as `Symbol`.

Once the envelope passes validation, existing semantics remain authoritative: cancellation wins over a late worker failure, active-lease identity fencing suppresses stale/duplicate failures, task-level error codes do not isolate a healthy worker, and isolatable error codes quarantine only the matching worker generation. Retry/isolation policy continues to derive from the validated closed `ErrorCode` taxonomy rather than caller assertions.

This contract is runtime protocol hardening only. It does not provide new evidence for real 1B WebGPU execution, physical GPU working-set limits, real multi-browser relay, or worker-loss resume behavior tracked elsewhere.
