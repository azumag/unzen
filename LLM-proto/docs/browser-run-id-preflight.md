# Browser run ID preflight

The real split browser harness and its local Coordinator use the same run-ID syntax for an immutable execution namespace:

```text
^[A-Za-z0-9._-]{1,128}$
```

`run-id.js` is the single browser-side source for both this syntax and the compatibility default run namespace. `BROWSER_RUN_ID_PATTERN` defines the accepted syntax and `DEFAULT_BROWSER_RUN_ID` remains exactly `demo`. `runner-bootstrap.js` uses them to derive and validate the `run` query parameter before loading ONNX Runtime or importing the full runner, `runner-v3.js` uses the same default for direct execution, and `coordinator-receipt-run-binding.js` reuses the same pattern and default when deriving the run expected on checkpoint/result receipts. The value is not trimmed, case-folded, truncated, decoded into a replacement value, or otherwise normalized.

The Coordinator keeps its independent `safeRunId()` validation on every run-scoped route. Browser preflight and receipt binding are early/client-side integrity checks and do not replace that server-side trust boundary.

The harness HTML loads only `runner-bootstrap.js`; validating solely in the full runner would be too late to prevent its static external module imports from resolving. The full runner still consumes the shared default as defense against direct module execution or future entrypoint changes, preventing the bootstrap and execution paths from drifting to different omitted-run namespaces. This contract is local browser/Coordinator hardening and is not real-model, physical-WebGPU, relay-latency, or worker-loss evidence.
