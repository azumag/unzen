# Demo diagnostics runtime boundary

The demo treats `ExecutionDiagnostics` as runtime-owned data. Even though the SDK exposes a typed shape, the value crosses a bundle/runtime boundary before the UI renders it, so malformed or hostile values must degrade to the existing `unknown` presentation instead of crashing the page.

Diagnostics validation snapshots the six fields used by the renderer exactly once for each validation or summary operation. A revoked root Proxy or any throwing field getter makes the diagnostics invalid. `summarizeDiagnostics()` renders from that owned operation-local snapshot rather than validating and then rereading the original object.

The `attempts` container is classified with a guarded `Array.isArray()` check because revoked Proxies can make the native operation throw. Its length and numeric indices are read directly under bounded guards; caller `map`, `Symbol.iterator`, and other iteration hooks are not invoked. The demo caps a single rendered diagnostics chain at 1024 attempts before allocating or reading entries, so a Proxy cannot synthesize an attacker-sized length. An unreadable or oversized attempts container invalidates the diagnostics, while an unreadable individual index or throwing attempt getter is isolated to that entry and becomes the existing safe `browser` / `unknown` / `null` fallback.

These rules preserve the existing public helpers and normal execution rendering output. They only strengthen the module's documented `never crash on bad input` contract; they do not change SDK protocol semantics, routing, diagnostics codes, or production behavior outside the demo renderer.
