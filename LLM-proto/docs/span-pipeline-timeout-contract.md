# SpanPipeline timeout / abort contract

`SpanPipeline` assigns one or more contiguous model segments to a browser worker. A span has a deadline of `span size * perSegmentTimeoutMs`.

Browser and Node timer delays are bounded to a signed 32-bit value, so `SpanPipeline` treats `2147483647ms` (`MAX_TIMER_DELAY_MS`) as the largest representable timeout or retry delay. `perSegmentTimeoutMs` and `retryDelayMs` above that boundary are rejected during constructor option preflight before optional residency dependencies are touched.

Before any span in a selected route mutates worker state or invokes the executor, `SpanPipeline` also preflights the effective deadline for every span. A per-segment value can be individually valid while multiplication by a multi-segment span exceeds the host timer range (or overflows JavaScript's finite number range). Either condition is rejected as a coordinator-side `SpanPipelineError` before a healthy worker can be marked busy or misclassified as disconnected.

## Timeout behavior

`SpanPipeline` passes an `AbortSignal` to `SpanExecutor.execute()`. When a representable span deadline expires, the signal is aborted before the pipeline rejects the timed-out execution. Executors should propagate that signal to transport, WebGPU scheduling loops, fetches, and other cancellable work so the abandoned span stops promptly.

The genuinely timed-out worker is then marked disconnected. If an `ArtifactResidencyLedger` is configured, that worker's residency snapshot is cleared because the coordinator can no longer trust either the execution result or its cache state. Coordinator-side deadline arithmetic/range rejection does not disconnect a worker or clear its residency.

Retry routing continues to use the existing bounded retry policy. A timeout does not make a late result authoritative: the timed-out invocation has already lost ownership of the route.

## Compatibility

The `signal` parameter on `SpanExecutor.execute()` is optional at the type boundary so existing test/prototype executors that accept only `(workerId, assignment)` remain structurally compatible. Production executors should consume the signal.

The externally visible timeout message remains compatible with the previous `SpanPipeline` contract (`"... timed out after ...ms"`) for representable deadlines, while the implementation uses the shared abortable timeout primitive. Explicit zero remains valid for immediate-timeout / no-delay semantics.

## Evidence boundary

The regression tests prove coordinator-side timeout arithmetic, host timer range enforcement, and cooperative cancellation semantics only. They do not prove that a real browser/WebGPU implementation actually stops GPU work, nor do they count as real prepared 1B, multi-browser relay, or worker-loss-resume evidence for #167.
