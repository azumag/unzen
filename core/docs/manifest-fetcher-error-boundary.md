# ManifestFetcher error boundary

`ManifestFetcher` may receive unusual JavaScript rejection values from fetch and response parsing. Its catch path treats those values as untrusted.

Existing `UnzenNetworkError` and `UnzenCancelledError` values are retained through a guarded identity check. Abort classification continues through `isAbortError()`, and the request signal still controls late cancellation.

For other failures, ordinary `Error` messages and primitive rejection text are preserved when safely readable. Unreadable object or function values use the stable `Unknown error` fallback rather than running their conversion hooks.

This change affects only error normalization. Manifest caching, ETag revalidation, request deduplication, cancellation, and invalidation behavior remain unchanged.
