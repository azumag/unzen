# DurableCoordinator worker-result runtime envelope contract

`DurableCoordinator` treats every resolved `ExecutionResult` from a browser/transport executor as untrusted runtime input. TypeScript interfaces are not a wire-protocol guarantee and no nested result field may be used before its containing runtime shape has been established.

## Top-level result and identity

Before request lookup, lease matching, cancellation handling, suppression recording, worker isolation, attempt accounting, checkpoint persistence, or final-result commit, the coordinator requires:

- the result to be a non-null, non-array object;
- `identity` to be a non-null, non-array object;
- `requestId`, `attemptId`, `leaseId`, `workerId`, and `workerGeneration` to be non-empty runtime strings;
- `segmentIndex` to be a non-negative safe integer;
- `processingTimeMs` to be a non-negative finite number.

Malformed values such as `Symbol`, arrays, objects, numeric strings, `NaN`, infinities, fractional indices, unsafe integers, and empty identifiers therefore fail closed as an intentional `protocol-violation` rather than escaping into property-access or string-coercion exceptions.

The pull execution loop never trusts a rejected result for worker isolation or attempt accounting. When result validation fails, those actions use the coordinator-owned `ExecutionAssignment` identity instead.

## Checkpoint boundary

Intermediate results still use `validateCheckpointEnvelope()` as the authoritative checkpoint runtime/integrity gate. Before the asynchronous integrity validation begins, the public wrapper snapshots the declared checkpoint metadata but deliberately does not clone the payload bytes. The durable core reads the payload reference once, establishes that it is a `Uint8Array`, and compares its actual `byteLength` with the configured `maxCheckpointBytes` ceiling before allocating an ownership copy.

An oversized payload is therefore rejected synchronously as `checkpoint-rejected`, recorded as a suppression, and isolated without allocating a checkpoint payload copy, entering SHA-256 digest work, or persisting any checkpoint. The direct durable-core path performs the same pre-copy byte check, so bypassing the public wrapper does not bypass the configured ceiling.

Only a payload that passes the byte ceiling is copied into coordinator-owned memory. The authoritative validator then rechecks structure, identity, the configured limit, TTL, and digest against that snapshot and performs digest work on validator-owned bytes. This preserves the existing mutation guarantee: once asynchronous integrity work begins, an executor cannot mutate its original payload or envelope fields and thereby change what is later committed. Removing the earlier wrapper copy also avoids one redundant ownership allocation on valid checkpoints.

Only a successfully validated snapshot is considered for durable commit. Existing lease re-check, cancellation re-check, request-stage check, TTL check, slot-conflict handling, and reclaim semantics remain unchanged.

## Final output boundary

A final result must carry an output object whose:

- container is a non-null, non-array object;
- `tokens` value is an array;
- every token is a non-negative safe integer;
- `text` is a runtime string.

The coordinator copies the validated token array before `commitCompletion()`, so durable completion state does not retain the executor-owned array reference.

Malformed final output returns `protocol-violation` without committing completion or reclaiming the active lease through the completion path.

## Failure and evidence boundary

These checks harden the durable coordinator's runtime trust boundary only. They do not provide new evidence for real Llama-3.2-1B q4 WebGPU execution, physical GPU working-set measurements, real multi-browser checkpoint relay, or worker-loss resume in issue #167, and they do not change the production/HOLD scope of issue #158.
