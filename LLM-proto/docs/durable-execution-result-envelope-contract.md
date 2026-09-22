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

Both the public `DurableCoordinator` wrapper and the separately exported direct durable-core class snapshot the reached result identity fields in fail-fast order. Throwing getters, revoked nested Proxies, and hostile Proxy traps are converted to stable malformed values for the implementation's existing diagnostics; caller-thrown values are never stringified or coerced. Once an earlier field is rejected, later identity fields are not read.

The pull execution loop never trusts a rejected result for worker isolation or attempt accounting. When result validation fails, those actions use the coordinator-owned `ExecutionAssignment` identity instead.

## Checkpoint boundary

Intermediate results still use `validateCheckpointEnvelope()` as the authoritative checkpoint runtime/integrity gate. Before the asynchronous integrity validation begins, the public wrapper snapshots the declared checkpoint metadata but deliberately does not clone the payload bytes. At the durable-core boundary, a payload that merely satisfies `instanceof Uint8Array` is not sufficient: it must also be a genuine TypedArray view with the required internal slots. Proxy-wrapped typed arrays therefore fail closed as `checkpoint payload must be a Uint8Array` instead of leaking a native TypedArray `TypeError`.

The separately exported direct durable-core class retains a trust-boundary shim because tests and integrations can invoke it without passing through the public wrapper. In addition to snapshotting the root result, identity, and `processingTimeMs` fields, that shim bounds its checkpoint container `Array.isArray()` probe and its lazy `checkpoint` / `payload` reads. Revoked Proxies and throwing checkpoint/payload accessors are converted to stable malformed sentinels that flow through the implementation's existing result/checkpoint diagnostics; caller-thrown values are discarded without stringification or coercion. The checkpoint read remains lazy and memoized, so a final result never touches a hostile checkpoint accessor merely because the shim is present.

After a direct-core checkpoint payload passes the intrinsic byte-length and configured pre-copy budget gates, checkpoint metadata is exposed through a shim-owned declared-key view. Object spread enumerates only that stable key set; it never invokes caller `ownKeys`. Each declared own-enumerable metadata field is inspected and read at most once with guarded descriptor/value access. Descriptor/getter failure is retained as a present invalid value rather than being mistaken for absence, including optional `previousCheckpointDigest`, and later caller metadata access is skipped after an inaccessible required field makes earlier validation failure inevitable. Unknown caller keys are ignored.

For a genuine `Uint8Array` (including subclasses), the core boundary reads `buffer`, `byteOffset`, and `byteLength` through the intrinsic TypedArray accessors and creates only a zero-copy base `Uint8Array` view. Caller-defined `byteLength`, iterator, `slice()`, or species hooks therefore cannot influence the pre-copy budget decision or run before it. The implementation then snapshots the configured `maxCheckpointBytes` ceiling, first requires that ceiling to be a non-negative safe integer, and compares the intrinsic payload byte length with that validated ceiling before allocating an ownership copy.

The public `DurableCoordinator` constructor applies the same safe-integer contract to `maxCheckpointBytes`, preserving explicit zero. The direct durable-core checkpoint path repeats the check because the core can be exercised directly by tests/integrations and must not rely solely on the public wrapper for allocation safety.

An invalid byte ceiling is therefore rejected synchronously as `checkpoint-rejected` with the validator-aligned diagnostic `checkpoint payload byte limit must be a non-negative safe integer`. An oversized payload is likewise rejected synchronously as `checkpoint-rejected`. Both failures are recorded as suppressions and isolated without allocating a checkpoint payload copy, entering SHA-256 digest work, or inspecting direct-caller checkpoint metadata.

Only a payload that passes a valid byte ceiling is copied into coordinator-owned memory. The authoritative validator then rechecks structure, identity, the same captured configured limit, TTL, and digest against that snapshot and performs digest work on validator-owned bytes. This preserves the existing mutation guarantee: once asynchronous integrity work begins, an executor cannot mutate its original payload or envelope fields and thereby change what is later committed. Removing the earlier wrapper copy also avoids one redundant ownership allocation on valid checkpoints.

Only a successfully validated snapshot is considered for durable commit. Existing lease re-check, cancellation re-check, request-stage check, TTL check, slot-conflict handling, and reclaim semantics remain unchanged.

## Final output boundary

A final result must carry an output object whose:

- container is a non-null, non-array object;
- `tokens` value is an array;
- every token is a non-negative safe integer;
- `text` is a runtime string.

The public wrapper and direct-core shim keep final output lazy until the implementation reaches the final-result branch. When reached, they snapshot the output container, `tokens`, token-array length and numeric slots, and `text` without invoking caller-controlled iteration. A revoked output/token container or throwing getter therefore fails through the established final-output diagnostics; invalid token capture stops before `text` is inspected. The implementation then copies the validated token array before `commitCompletion()`, so durable completion state does not retain the executor-owned array reference.

Malformed final output returns `protocol-violation` without committing completion or reclaiming the active lease through the completion path.

## Failure boundary

`handleWorkerFailure()` treats its failure envelope with the same ownership discipline. The direct-core shim snapshots the root container, result identity, failure code, and message in the implementation's fail-fast order. Inaccessible identity/code/message fields are represented as stable malformed values, later fields are not touched after an earlier rejection, and caller-thrown values are never coerced. The implementation remains authoritative for the existing `execution failure ...` diagnostics and for retry, lease reclaim, and worker-isolation policy.

## Evidence boundary

These checks harden the durable coordinator's runtime trust boundary only. They do not provide new evidence for real Llama-3.2-1B q4 WebGPU execution, physical GPU working-set measurements, real multi-browser checkpoint relay, or worker-loss resume in issue #167, and they do not change the production/HOLD scope of issue #158.
