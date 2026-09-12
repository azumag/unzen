# Prototype transport origin allowlist

`AllowlistedPrototypeTransport` models the Coordinator/CDN-only network boundary used by the contract harnesses. Configuration values are URLs, while authorization is performed at the URL **origin** level.

At construction time every configured URL is parsed with `URL`, reduced to its canonical `origin`, deduplicated, and stored as a frozen defensive snapshot. This means normal configuration forms such as a trailing slash or deployment path do not accidentally reject a same-origin request, while a later mutation of the caller-owned configuration array cannot expand the allowed network boundary.

URLs without a network origin fail closed during construction. `connect()` independently parses the requested URL and permits it only when its canonical origin is present in the frozen allowlist. A different scheme, host, or effective port remains a different origin and is rejected.

This is prototype configuration/trust-boundary behavior only. It does not constitute evidence for a real Coordinator/CDN network relay, browser-to-browser continuation, relay latency, or worker-loss recovery.
