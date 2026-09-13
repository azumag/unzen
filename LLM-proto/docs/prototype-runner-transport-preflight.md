# Prototype runner transport preflight

`TwoWorkerPrototypeRunner.run()` treats the selected Coordinator/CDN URLs and the injected `AllowlistedPrototypeTransport` as one runtime configuration envelope.

After validating the run-options container, prompt, and URL syntax, but before allocating a request ID or invoking a worker, the runner now verifies that both selected origins satisfy the transport's existing allowlist contract. The check is side-effect free: it uses the same URL parsing and origin comparison as `connect()` without appending connection history.

This ordering prevents a knowably incompatible configuration from partially starting a run. In particular, a rejected Coordinator/CDN origin does not:

- append a successful first origin before a later origin fails;
- consume a `proto-N` request ID;
- invoke segment workers or change their cached-segment authority;
- consume the primary segment-1 worker's one-shot simulated loss state.

For accepted runs, `connect()` remains the authority that records each actual simulated connection, so existing connection-history and failover behavior are unchanged. This preflight does not expand the allowlist, introduce fallback networking, or add checkpoint semantics.

This is simulated-harness reliability coverage under #167. It is not evidence of real browser WebGPU execution, physical GPU memory use, real multi-browser relay latency, or worker-loss recovery on real hardware.
