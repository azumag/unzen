# Browser run ID preflight

The real split browser harness and its local Coordinator use the same run-ID syntax for an immutable execution namespace:

```text
^[A-Za-z0-9._-]{1,128}$
```

`runner-bootstrap.js` validates the `run` query parameter (default `demo`) before loading ONNX Runtime or importing the full runner. The value is not trimmed, case-folded, truncated, decoded into a replacement value, or otherwise normalized. An invalid namespace therefore fails before worker registration, artifact/tokenizer work, inference, or a run-scoped Coordinator request.

The Coordinator keeps its independent `safeRunId()` validation on every run-scoped route. Browser preflight is an early-failure optimization and does not replace that server-side trust boundary.

The harness HTML loads only `runner-bootstrap.js`; validating solely in the full runner would be too late to prevent its static external module imports from resolving. This contract is local browser/Coordinator hardening and is not real-model, physical-WebGPU, relay-latency, or worker-loss evidence.
