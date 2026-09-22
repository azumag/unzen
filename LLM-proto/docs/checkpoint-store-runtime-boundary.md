# CheckpointStore runtime trust boundary

`CheckpointStore` accepts checkpoint values that can originate at a runtime/worker boundary. TypeScript types are therefore not sufficient authority for direct `save()`, `assertValidCheckpoint()`, or `snapshotValidatedCheckpoint()` calls.

## Container and field access

The direct store boundary classifies the checkpoint and metadata containers as non-null, non-array records with guarded array classification. A revoked Proxy must fail through the normal checkpoint validation taxonomy rather than leaking the native exception produced by `Array.isArray()`.

Fields consumed by validation are read once in validation order. If a checkpoint or metadata getter/Proxy trap throws, the thrown value is not stringified, inspected, or coerced. Validation instead reports the established diagnostic for the field being read. This keeps a caller-controlled `Symbol.toPrimitive`, `valueOf`, or `toString` hook outside the error path.

## Hidden states

`hiddenStates` must remain a non-empty `Uint8Array`. Runtime classification and the intrinsic copy are bounded by the same validation error, and accepted bytes are copied into a base `Uint8Array` owned by the checkpoint snapshot. Later caller mutation therefore cannot rewrite the stored resume point.

## Shape

`metadata.shape` remains a fixed rank-3 checkpoint protocol field. Its array classification, `length`, and three canonical numeric-index reads are bounded separately. The validator does not use caller iteration. Revoked proxies and throwing length/index traps fail through the existing invalid-shape diagnostics before any unbounded allocation or iteration.

Valid shapes are copied into an owned plain array before persistence.

## Compatibility

This hardening does not change checkpoint schema, rank, dtype/sequence/timestamp validation, request or segment identity, `save/get/latest/deleteAll` behavior, or the existing ownership copies at the store boundary. It only makes direct store validation fail closed when JavaScript runtime values violate the typed contract.

## Evidence boundary

This is host/runtime checkpoint-boundary reliability hardening for #1412 and #167. It is not new evidence for a real `Llama-3.2-1B-Instruct` q4 artifact, physical WebGPU execution, distinct-browser Coordinator relay/latency, worker-loss/resume, or artifact residency. No production credentials, deployment, billing, or external model/artifact fetch is involved.
