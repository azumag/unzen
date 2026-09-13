# Simulated prototype worker execution envelope

`SimulatedPrototypeWorker.execute()` is a runtime boundary even though its TypeScript input type is internal. Callers may arrive through JavaScript, decoded data, casts, or future adapter layers, so compile-time typing is not sufficient to protect transport and worker state.

Before any execution side effect, the worker now snapshots and validates the values it actually consumes:

- the top-level input is a non-null, non-array object;
- `requestId` satisfies the existing `inferenceRequestId()` non-empty-string contract;
- `prompt` is a string;
- `coordinatorUrl` and `cdnUrl` are valid absolute URLs with network origins;
- `transport` is an `AllowlistedPrototypeTransport`;
- segment 1 receives a checkpoint object whose `hiddenStates` is a `Uint8Array`.

Only after that preflight may the worker append transport history, consume the configured one-shot simulated failure, or update its cached-segment authority. A malformed execution envelope therefore leaves those three state surfaces unchanged, and a malformed call cannot consume `failFirstRun`.

This boundary intentionally does not add checkpoint semantics the simulated worker does not consume. It does not require checkpoint request-id equality, validate checkpoint metadata, or impose new segment-index policy. Those would be separate protocol decisions. The transport allowlist remains authoritative when `connect()` executes.

This is reliability coverage for the simulated two-worker harness under #167. It is not evidence of real browser WebGPU execution, real model artifact materialization, physical GPU memory usage, multi-browser relay latency, or worker-loss recovery on real hardware.
