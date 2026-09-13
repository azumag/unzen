# Pipeline worker-result runtime envelope contract

`Pipeline` and `SpanPipeline` treat executor results as untrusted runtime input even though their TypeScript interfaces expose `SegmentResult` and `SpanResult`.

A resolved executor promise therefore does not make the worker result trustworthy. The coordinator validates the runtime envelope before marking a worker idle, persisting a checkpoint, recording artifact residency, or returning final output.

## Top-level envelope

Both result paths require a non-null, non-array object before reading any field. Identity and range fields are validated for their runtime types before comparison or diagnostic formatting so values such as `Symbol`, arrays, objects, numeric strings, `NaN`, infinities, fractional indices, and unsafe integers cannot escape into incidental JavaScript coercion errors.

For `SegmentResult`:

- `requestId` and `workerId` must be strings and must echo the assigned identities.
- `segmentIndex` must be a non-negative safe integer and must equal the assigned segment.
- `processingTimeMs` must be a non-negative finite number.

For `SpanResult`:

- `requestId` and `workerId` must be strings and must echo the assigned identities.
- `startSegment` and `endSegment` must be non-negative safe integers and must match the assigned span exactly.
- `processingTimeMs` must be a non-negative finite number.

## Checkpoint boundary

The existing final/non-final boundary rules remain authoritative:

- a final segment/span must not produce a checkpoint;
- a non-final segment/span must produce one;
- non-final checkpoint identity must match the request and completed boundary.

Before nested checkpoint fields are read, the checkpoint must itself be a non-null, non-array object. Its `requestId` must be a string and its `segmentIndex` a non-negative safe integer. `CheckpointStore.assertValidCheckpoint()` is then used as the single full-payload authority for hidden-state and metadata validation. `CheckpointStore.save()` applies the same validation again while taking its ownership-isolated snapshot.

For both pipeline paths, that durable snapshot is committed while the assigned worker is still inside the failure boundary. `Pipeline` commits an intermediate checkpoint before `markIdle()`. `SpanPipeline` commits it before both `markIdle()` and artifact-residency recording. If save-time validation or snapshotting fails, the worker is disconnected rather than becoming reusable with an uncommitted boundary.

## Final output boundary

A final segment/span must produce an output object. Before `tokens` or `text` are returned to the caller, the output must be a non-null, non-array object, `tokens` must be an array of non-negative safe integers, and `text` must be a string. Non-final results continue to reject any output before it can be accepted.

## Failure behavior

Malformed worker results fail closed with `PipelineError` or `SpanPipelineError`. The worker is disconnected, no malformed checkpoint is committed, and request cleanup removes any retained checkpoints on terminal failure. The checks and checkpoint snapshot commit intentionally run before worker-idle and artifact-residency commit points.

These checks are runtime protocol hardening only. They do not provide real-model WebGPU, physical GPU-memory, multi-browser relay, or worker-loss-resume evidence for issue #167 and do not change the production/HOLD scope in issue #158.
