# Prototype transport origin allowlist

`AllowlistedPrototypeTransport` models the Coordinator/CDN-only network boundary used by the contract harnesses. Configuration values are URLs, while authorization is performed at the URL **origin** level.

At construction time the top-level allowlist must be an array and every entry must be a non-empty runtime string before URL parsing. Every configured URL is then parsed with `URL`, reduced to its canonical `origin`, deduplicated, and stored as a frozen defensive snapshot. This means normal configuration forms such as a trailing slash or deployment path do not accidentally reject a same-origin request, while a later mutation of the caller-owned configuration array cannot expand the allowed network boundary.

URLs without a network origin fail closed during construction. `connect()` independently requires a non-empty runtime string, parses the requested URL with a deterministic validation error for malformed URLs, and permits it only when its canonical origin is present in the frozen allowlist. A different scheme, host, or effective port remains a different origin and is rejected. Validation and allowlist checks happen before `connectionLog` mutation, so rejected runtime inputs cannot create a partial connection history.

The explicit runtime checks are important because asserted/decoded values can bypass TypeScript's `readonly string[]` / `string` signatures. In particular, symbols and non-array top-level values are rejected before iteration, URL coercion, or diagnostic interpolation can throw incidental JavaScript errors.

This is prototype configuration/trust-boundary behavior only. It does not constitute evidence for a real Coordinator/CDN network relay, browser-to-browser continuation, relay latency, or worker-loss recovery.

Related: #584, #167.
