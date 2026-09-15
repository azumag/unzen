# SpanPipeline segment ownership contract

`SpanPipeline` treats segment geometry as runtime-untrusted constructor input and owns a detached snapshot for the lifetime of the pipeline.

## Ownership

Construction captures the caller-owned array length and then reads each array position directly. It does not depend on the array iterator. Every captured segment is validated using the same contract as `SpanRouter`, copied into a plain `SegmentConfig`, and frozen. The resulting array is also frozen.

This means later caller mutation cannot change:

- segment count or membership;
- segment indexes and layer ranges;
- model-weight identity;
- per-segment VRAM estimates;
- which segment records are placed into later span assignments;
- final-span detection or `segmentsCompleted` accounting.

The same detached snapshot is used for artifact-residency compatibility checks, routing input, assignment slicing, checkpoint bounds, and completion accounting.

## Why this matters

`SpanRouter` already snapshots its input, but a pipeline previously retained the original caller-owned array and kept reading it after routing began. A mutation between spans could therefore make the router and executor observe different segment geometry. Long-lived multi-segment execution under #167 requires one stable geometry across routing, retry, checkpoint, and artifact-residency decisions.

## Non-goals / evidence boundary

This contract hardens coordinator-side ownership only. It does not provide new evidence for real `Llama-3.2-1B-Instruct` q4 artifact sizes, physical WebGPU memory usage, real multi-browser checkpoint relay, or worker-loss resume. It does not change the production-deployment HOLD in #158.
