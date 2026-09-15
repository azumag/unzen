# Worker-result checkpoint snapshot boundary

Legacy `Pipeline` and `SpanPipeline` treat browser-worker results as runtime-untrusted even though the TypeScript protocol marks checkpoint fields as readonly.

The worker-result boundary now owns the complete nested checkpoint envelope before later identity checks and persistence can consume it. The boundary captures `requestId`, `segmentIndex`, `hiddenStates`, and the declared metadata fields once. `hiddenStates` and `metadata.shape` are copied, so mutation of worker-owned buffers or arrays after result validation cannot change the value that is subsequently validated or committed.

`CheckpointStore.snapshotValidatedCheckpoint()` is the corresponding storage-boundary helper. It validates a captured checkpoint and returns another ownership-isolated value before `save()` derives its request/segment key. This keeps the persisted key and payload tied to the same validated identity.

The result-root snapshot is shared by both legacy pipeline paths, so assignment checks, `CheckpointStore.assertValidCheckpoint()`, and the later `save()` observe the same owned checkpoint rather than rereading accessor- or Proxy-backed worker state. Final-segment/final-span rules remain unchanged: a final result must not carry a checkpoint.

This contract is runtime hardening only. It does not change production deployment, credentials, billing, operator authorization, or the evidence status tracked by issue #167.
