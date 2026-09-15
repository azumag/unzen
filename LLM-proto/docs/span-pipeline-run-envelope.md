# SpanPipeline run envelope contract

`SpanPipeline` owns an immutable segment snapshot from construction time. A caller-provided `InferenceRequest`, however, is still an ordinary JavaScript object at runtime even though `id` and `totalSegments` are marked `readonly` by TypeScript. Accessor-backed objects, Proxies, and retained references can therefore return or install different values after asynchronous execution begins.

To keep one inference run on one durable identity and geometry, `SpanPipeline.run()` captures these fields before any worker or checkpoint side effect:

- `id` — must be a non-empty string and becomes the run's request identity;
- `totalSegments` — must be a non-negative safe integer and must equal the pipeline-owned segment count;
- initial `currentSegment` — must be a non-negative safe integer so malformed caller state is rejected before execution.

The captured values form the run envelope. Later span assignment, checkpoint lookup/save/cleanup, checkpoint/result identity validation, error identity, final result identity, final progress and `segmentsCompleted` all use that envelope rather than rereading caller-owned identity/geometry fields.

The request object remains the caller-visible progress surface. `status` and `currentSegment` continue to be updated during execution, so existing progress observers remain compatible. Mutating `id` or `totalSegments` through a retained JavaScript reference after `run()` begins cannot redirect later checkpoint operations or change the returned result identity.

A geometry mismatch fails before routing, executor invocation, or checkpoint mutation. Zero-segment pipelines remain valid only when the request also declares `totalSegments === 0`; they complete without worker execution.

Regression coverage includes changed-on-second-read accessors, explicit mid-run mutation between spans, mismatch fail-closed behavior with pre-existing checkpoint state, and the zero-segment path.
