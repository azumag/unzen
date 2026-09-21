# SpanRouter hostile Proxy runtime boundary

Tracking: #1334. Parent technical-core work: #167.

`SpanRouter` consumes segment geometry that may cross a JavaScript runtime trust boundary before routing and residency checks. TypeScript `readonly SegmentConfig[]` annotations do not prevent callers from supplying Proxy-backed arrays, revoked Proxies, accessor-backed records, or getters that throw arbitrary values.

The router therefore establishes an owned snapshot before any routing decision:

- the top-level value must pass a bounded `Array.isArray()` check;
- array `length` and each indexed membership read are bounded, and caller iterators are never invoked;
- revoked or unreadable array containers fail through router-owned diagnostics instead of leaking native/caller exceptions;
- each segment must be a non-null, non-array record under a bounded shape check;
- `index`, `layerStart`, `layerEnd`, `modelWeightHash`, and `estimatedVramMB` are read exactly once in the existing fail-fast order;
- throwing field accessors are mapped to the same field validation diagnostics used for malformed values, without stringifying, coercing, or otherwise inspecting the thrown value;
- only the validated owned records are frozen and retained for route construction and manifest-backed residency compatibility checks.

These checks do not broaden accepted inputs or change valid routing behavior. They only make invalid hostile runtime inputs fail closed deterministically. This reliability hardening is not evidence of real-model execution, physical WebGPU, distinct-browser checkpoint relay/latency, worker-loss recovery, or artifact residency for #167.
