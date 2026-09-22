# Durable result/failure runtime boundary

`DurableCoordinator` treats execution results and execution failures as transport-facing, worker-owned runtime data. TypeScript interfaces are documentation only; callers can still provide accessors, Proxies, revoked Proxies, or values whose coercion hooks throw.

Before the durable core sees a reached field, the public wrapper captures it once in the core's existing fail-fast order. A getter or Proxy trap failure is converted to an invalid primitive owned by the wrapper. The caller-thrown value is never stringified, inspected, or coerced. Revoked top-level result/failure containers are likewise converted to a safe malformed value so the core can emit its existing protocol diagnostic instead of leaking a native `TypeError` from `Array.isArray()` or property access.

Result identity fields (`requestId`, `attemptId`, `leaseId`, `workerId`, `workerGeneration`, `segmentIndex`) and `processingTimeMs` remain fail-fast. Later fields are not touched after an earlier invalid or inaccessible field. Final `output` and intermediate `checkpoint` remain lazy and memoized, so a final result does not inspect checkpoint data and an intermediate result does not inspect final output.

Final-output capture bounds `tokens`/`text`, `Array.isArray()`, array `length`, and numeric-index reads. Token arrays are read numerically rather than through caller-controlled iteration, and inaccessible token/text values flow through the existing final-output validation taxonomy. Checkpoint capture keeps the separate payload-first and metadata hardening contract documented elsewhere.

Failure capture applies the same rules to `identity`, `code`, and `message`; code validation still precedes message access. Retry, disconnect, lease, generation, checkpoint, and recovery semantics are unchanged.

This is runtime trust-boundary hardening only. It is not new evidence for real-model execution, physical WebGPU capability, distinct-browser relay/latency, worker-loss recovery, measured artifact residency, production deployment, or billing behavior.
