# Backend routing request runtime boundary

`capabilityMatchesRequest()` treats both the capability and the request envelope as runtime-untrusted values even though its public TypeScript signature is typed.

Before routing, the request side is reduced to an owned snapshot of only `protocolVersion`, `maxTokens`, and `requiresStreaming`. The top-level value must be a non-array object. Array classification is bounded so a revoked `Proxy` is treated as an invalid request instead of leaking the native `Array.isArray()` exception. Each routing field is then read exactly once inside one guarded read; a throwing accessor invalidates the request and the request matches no backend.

After capture, routing uses only the owned primitive values. Unsupported protocol versions, invalid token limits, and non-boolean streaming requirements match nothing. Valid request behavior is unchanged.

This boundary is a routing reliability/fail-closed contract. It does not establish new real-model, WebGPU, multi-browser relay, cache-residency, or production deployment evidence for issue #167.
