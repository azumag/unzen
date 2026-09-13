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

Intermediate results still use `validateCheckpointEnvelope()` as the authoritative checkpoint runtime/integrity gate. Before the asynchronous integrity validation begins, the coordinator performs only the minimal copy-safe shape checks needed to establish an object container and `Uint8Array` payload, then snapshots the full envelope and copies the payload bytes into coordinator-owned memory.

The authoritative validator runs against that ownership-isolated snapshot. This ordering satisfies both sides of the boundary: malformed checkpoint containers or payload values fail intentionally before cloning, while an executor cannot mutate its original payload or envelope fields during asynchronous digest validation and thereby change what is later committed.

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
