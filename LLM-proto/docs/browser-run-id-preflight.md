# Browser run ID preflight

The real split browser harness and its local Coordinator use the same run-ID syntax for an immutable execution namespace:

```text
^[A-Za-z0-9._-]{1,128}$
```

`run-id.js` is the single browser-side source for this syntax. `runner-bootstrap.js` uses it to validate the `run` query parameter (default `demo`) before loading ONNX Runtime or importing the full runner, and `coordinator-receipt-run-binding.js` reuses the same pattern when deriving the run expected on checkpoint/result receipts. The value is not trimmed, case-folded, truncated, decoded into a replacement value, or otherwise normalized.

The Coordinator keeps its independent `safeRunId()` validation on every run-scoped route. Browser preflight and receipt binding are early/client-side integrity checks and do not replace that server-side trust boundary.

The harness HTML loads only `runner-bootstrap.js`; validating solely in the full runner would be too late to prevent its static external module imports from resolving. This contract is local browser/Coordinator hardening and is not real-model, physical-WebGPU, relay-latency, or worker-loss evidence.
