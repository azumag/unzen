# CodeFetcher rejection-value trust boundary

`CodeFetcher` can receive arbitrary JavaScript rejection values from `fetch()` and other asynchronous helpers. Its catch path must therefore not assume that a rejection is a normal `Error` instance or that object coercion is safe.

Existing `UnzenNetworkError` values are rethrown unchanged, but the identity test is bounded so a revoked Proxy cannot escape through `instanceof`. Abort classification remains authoritative and uses the shared bounded `isAbortError()` helper.

For remaining failures, ordinary `Error` messages and primitive rejection text are preserved when they can be read without executing caller-controlled object coercion. Object/function rejection values that are not safely readable Errors use the stable `Unknown error` fallback. Revoked Proxies and throwing `message` accessors therefore remain inside the intended `UnzenNetworkError` mapping, and `toString`, `valueOf`, or `Symbol.toPrimitive` hooks on hostile objects are not invoked.

This boundary changes only error normalization. Cancellation precedence, content verification, cache publication, and fallback policy are unchanged.
