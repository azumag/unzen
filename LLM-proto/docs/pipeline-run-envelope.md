# Pipeline run envelope contract

The basic `Pipeline` executes one segment at a time and exposes progress through the caller-provided `InferenceRequest`. TypeScript marks request identity/geometry fields readonly, but runtime callers can still provide accessor-backed objects, Proxies, or retained plain-object references that change during asynchronous retries.

`Pipeline.run()` therefore captures `id`, `totalSegments`, and the initial `currentSegment` exactly once before worker or checkpoint side effects. The request ID must be a non-empty string; both numeric fields must be non-negative safe integers; `currentSegment` cannot exceed `totalSegments`; and `totalSegments` must equal the pipeline's owned segment snapshot. For non-zero pipelines, `currentSegment` must identify an executable segment (`currentSegment < totalSegments`); an exhausted value equal to `totalSegments` cannot reconstruct the already-produced final output and is rejected at this boundary.

The pipeline builds an internal run request view from those captured values. All later checkpoint lookup/cleanup, assignments, worker-result/checkpoint validation, final-boundary detection, errors, and final result geometry read from that stable view. `status` and `currentSegment` writes remain forwarded to the caller's original request so progress observers retain the existing behavior.

A validated zero-segment request (`totalSegments === 0` and therefore `currentSegment === 0`) is an immediate successful no-op, matching `SpanPipeline`. No worker or executor is invoked, the request becomes `COMPLETED`, an empty result with `segmentsCompleted: 0` is returned, and any stale checkpoints under the captured request ID are deleted. Geometry validation still happens before this cleanup, so malformed zero-segment requests cannot erase checkpoint state.

The pipeline also snapshots segment membership and each segment's routing geometry at construction using the same validated snapshot contract as `SpanPipeline`. Caller mutation of the source array or segment objects cannot change a run's segment index, layer range, model hash, or VRAM requirement after construction.

A request geometry mismatch fails before execution or checkpoint mutation. Regression coverage includes changed-on-second-read accessors, explicit mid-run request mutation, no-side-effect mismatch behavior, zero-segment no-op completion with stale-checkpoint cleanup, exhausted non-zero resume rejection, and post-construction segment mutation.
