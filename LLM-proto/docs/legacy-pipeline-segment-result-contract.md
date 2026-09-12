# Legacy Pipeline SegmentResult contract

The legacy `Pipeline` remains a contract-tested prototype for segmented inference. It is not production deployment or real WebGPU evidence, but worker results still cross a trust boundary and must fail closed before checkpoint state or final output is accepted.

For every resolved `SegmentExecutor.execute()` result, `Pipeline` now validates the echoed execution identity before marking the worker idle:

- `requestId` must exactly match the active inference request.
- `segmentIndex` must exactly match the assigned segment.
- `workerId` must exactly match the assigned worker.
- `processingTimeMs` must be finite and non-negative.

Boundary shape is also enforced:

- A non-final segment must return exactly a checkpoint boundary: no final output, a checkpoint must be present, and that checkpoint must match the active request and completed segment.
- The final segment must return final output and must not return another resumable checkpoint.

A worker that resolves with a contract-violating result is treated like a failed execution attempt: it is marked disconnected and the normal bounded retry path may choose another worker. No malformed checkpoint is committed and no mismatched output completes the request.

This mirrors the fail-closed result checks already present in `SpanPipeline`. It strengthens the prototype checkpoint/relay contract for #167 but does **not** demonstrate a prepared 1B model, browser WebGPU execution, multi-browser relay, GPU working-set telemetry, or worker-loss resume on real infrastructure.

Regression coverage lives in `tests/pipeline-result-contract.test.ts`.
