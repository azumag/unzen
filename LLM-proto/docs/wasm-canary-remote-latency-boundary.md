# Remote Wasm canary latency boundary

The remote Wasm canary checker reports diagnostic per-sample latency only after a successful response has been fully consumed within the 64 KiB ceiling, decoded as fatal UTF-8, parsed as JSON, and accepted by the pinned canary contract.

This means `elapsedMs` is not a headers-only timing. A slow response body is part of the recorded sample. The measurement remains diagnostic and is not production SLO evidence or a stable performance ranking.

For non-success HTTP responses, the checker does not parse the body. It best-effort cancels the unread response stream before reporting the HTTP failure so repeated or failed checks do not unnecessarily retain response-body resources.

The checker continues to reject non-HTTPS URLs, embedded credentials, non-`workers.dev` hosts, malformed UTF-8, malformed JSON, oversized successful response bodies, and payloads that do not match the pinned canary contract.

This change does not perform an external canary request, deployment, credential use, billing action, readiness promotion, or real-model/WebGPU evidence capture.
