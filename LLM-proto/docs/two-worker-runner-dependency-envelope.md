# TwoWorkerPrototypeRunner dependency envelope

`TwoWorkerPrototypeRunner` models a fixed prototype topology:

- one `SimulatedPrototypeWorker` for segment 0;
- one primary `SimulatedPrototypeWorker` for segment 1;
- one standby `SimulatedPrototypeWorker` for segment 1;
- an optional `AllowlistedPrototypeTransport`.

The constructor is a runtime trust boundary. TypeScript annotations alone are not sufficient because asserted, decoded, JavaScript, or cross-package callers can provide malformed values.

## Runtime contract

`undefined` remains the supported default-construction path. When constructor options are provided, they must be a non-null, non-array object.

Provided dependencies must be concrete prototype instances:

- `transport` must be an `AllowlistedPrototypeTransport`;
- `segment0`, `segment1Primary`, and `segment1Standby` must be `SimulatedPrototypeWorker` instances.

The runner also validates fixed topology before accepting the dependencies:

- `segment0.segmentIndex === 0`;
- `segment1Primary.segmentIndex === 1`;
- `segment1Standby.segmentIndex === 1`.

`SimulatedPrototypeWorker.id` and `segmentIndex` are made non-writable and non-configurable after their constructor validates them. Caller-side JavaScript or cast-based mutation therefore cannot invalidate a runner topology after it has passed constructor validation.

Malformed containers, malformed injected dependencies, and wrong-role workers fail synchronously during construction. They cannot survive until `run()` and therefore cannot consume a request ID, mutate worker cache state, or append transport history through this runner.

## Compatibility

Default construction and valid custom dependency injection retain the existing behavior. Per-run prompt and URL validation remain separate runtime boundaries. Worker cache state and the one-shot simulated failure flag remain intentionally mutable internal execution state; only validated worker identity and fixed segment role are locked.

## Evidence boundary

This contract protects the simulated two-worker harness only. It does not prove real prepared-model execution, WebGPU cancellation, physical GPU working-set behavior, real multi-browser relay, or worker-loss resume. Those remain separate evidence requirements under #167.
