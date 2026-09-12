# WorkerPool busy segment-index contract

Tracking: #524. Parent technical-core work: #167.

The legacy `WorkerPool` stores `currentSegment` as coordinator routing state. Runtime callers may cross the TypeScript boundary, so `markBusy()` validates the segment cursor before changing worker state.

Contract:

- `segmentIndex` must be a non-negative JavaScript safe integer.
- Negative, fractional, non-finite, unsafe, and non-number runtime values are rejected.
- Validation happens before `status` or `currentSegment` is mutated.
- A valid segment index for an unknown worker preserves the existing no-op behavior.
- Valid registered-worker assignments retain the existing BUSY/currentSegment behavior.

This is coordinator-side legacy routing hardening only. It is not real multi-browser WebGPU, checkpoint-relay, worker-loss-resume, or production deployment evidence for #167/#158.
