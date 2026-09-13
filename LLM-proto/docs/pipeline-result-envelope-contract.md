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

Before nested checkpoint fields are read, the checkpoint must itself be a non-null, non-array object. Its `requestId` must be a string and its `segmentIndex` a non-negative safe integer. `CheckpointStore` remains the authority for the full checkpoint payload contract, including hidden-state and metadata validation; the pipeline only validates enough of the envelope to avoid unsafe dereference and to prove routing identity before durable commit.

## Final output boundary

A final segment/span must produce an output object. Before `tokens` or `text` are returned to the caller, the output must be a non-null, non-array object, `tokens` must be an array, and `text` must be a string. Non-final results continue to reject any output before it can be accepted.

## Failure behavior

Malformed worker results fail closed with `PipelineError` or `SpanPipelineError`. The worker is disconnected, no malformed checkpoint is committed, and request cleanup removes any retained checkpoints on terminal failure. The checks intentionally run before worker-idle and artifact-residency commit points.

These checks are runtime protocol hardening only. They do not provide real-model WebGPU, physical GPU-memory, multi-browser relay, or worker-loss-resume evidence for issue #167 and do not change the production/HOLD scope in issue #158.
