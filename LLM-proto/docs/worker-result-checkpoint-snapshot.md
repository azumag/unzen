# Worker-result checkpoint snapshot boundary

Legacy `Pipeline` and `SpanPipeline` treat browser-worker results as runtime-untrusted even though the TypeScript protocol marks checkpoint fields as readonly.

The worker-result boundary now owns the complete nested checkpoint envelope before later identity checks and persistence can consume it. The boundary captures `requestId`, `segmentIndex`, `hiddenStates`, and the declared metadata fields once. `hiddenStates` and `metadata.shape` are copied, so mutation of worker-owned buffers or arrays after result validation cannot change the value that is subsequently validated or committed.

The result root itself is also a runtime trust boundary. `Pipeline` and `SpanPipeline` classify result records with a bounded `Array.isArray()` check, so revoked root proxies fail through the normal `segment result must be a non-null, non-array object` / `span result must be a non-null, non-array object` diagnostics instead of leaking native Proxy exceptions. Once a record reaches `snapshotSegmentResultRoot()` or `snapshotSpanResultRoot()`, every declared root field is read at most once; a throwing getter is replaced with a stable invalid sentinel without inspecting, stringifying, or coercing the thrown value.

Checkpoint and metadata records use the same bounded classification. A revoked checkpoint or metadata proxy is converted to a stable invalid value and is rejected by the existing pipeline/checkpoint validation taxonomy. Nested checkpoint and metadata fields remain lazy and memoized: a final result that is invalid merely because it carries a checkpoint can still be rejected without touching `checkpoint.requestId`, `segmentIndex`, `hiddenStates`, metadata, shape, or other nested accessors. When a nested field is eventually needed, accessor failure is captured once and subsequent validation observes the same invalid snapshot.

Checkpoint `metadata.shape` is captured without caller iteration. `Array.isArray()`, `length`, and the three canonical numeric-index reads are individually bounded; revoked proxies, throwing length traps, or throwing member traps collapse to the existing invalid-shape path instead of escaping a worker-controlled exception. Valid shapes are copied into an owned frozen rank-3 array before checkpoint validation or persistence.

The hidden-state copy is also a runtime TypedArray trust boundary. A payload must be a genuine `Uint8Array` view before byte operations run. Proxy-wrapped typed arrays fail closed through the normal checkpoint validation path instead of leaking native internal-slot errors. Genuine `Uint8Array` subclasses are measured through intrinsic TypedArray `buffer` / `byteOffset` / `byteLength` accessors and copied through a base `Uint8Array` view, so caller-defined `byteLength`, `slice`, iterator, or species hooks do not participate in snapshot sizing or ownership transfer.

This byte capture remains lazy. A final result that is invalid merely because it carries a checkpoint can still be rejected before hostile nested checkpoint accessors are touched; when `hiddenStates` is first consumed, the captured value is memoized and reused by subsequent identity validation and persistence.

`CheckpointStore.snapshotValidatedCheckpoint()` is the corresponding storage-boundary helper. It validates a captured checkpoint and returns another ownership-isolated value before `save()` derives its request/segment key. This keeps the persisted key and payload tied to the same validated identity.

The result-root snapshot is shared by both legacy pipeline paths, so assignment checks, `CheckpointStore.assertValidCheckpoint()`, and the later `save()` observe the same owned checkpoint rather than rereading accessor- or Proxy-backed worker state. Final-segment/final-span rules remain unchanged: a final result must not carry a checkpoint.

This contract is runtime hardening only. It does not change production deployment, credentials, billing, operator authorization, or the evidence status tracked by issue #167.
