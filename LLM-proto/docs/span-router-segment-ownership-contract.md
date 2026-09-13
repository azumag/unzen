# SpanRouter segment ownership contract

Tracking: #521, #531. Parent technical-core work: #167.

`SpanRouter` treats supplied segment geometry and resume boundaries as runtime-untrusted coordinator input, not as mutable routing state owned by the caller.

Contract:

- `segments` must be an actual array at runtime.
- The router snapshots and freezes the array and each `SegmentConfig` object before storing them.
- Each segment `index` must be an actual JavaScript `number` before zero-based identity checks or error formatting. Non-number asserted/decoded values such as strings, objects, and `Symbol` values fail with an intentional router validation error rather than JavaScript coercion errors.
- Index/VRAM validation and optional `ArtifactResidencyLedger` compatibility checks run against that same snapshot.
- Mutating, appending to, or removing from the caller-owned array after construction cannot change span capacity or route coverage.
- `computeRoute(startSegment)` requires an actual JavaScript `number` before integer/range validation. Valid resume boundaries remain integers in `0..segments.length`, including the terminal boundary that returns an empty route.
- Existing cache-locality, tier, capacity, and backtracking preferences are unchanged.

The runtime type checks happen before rejected index values are interpolated into detailed numeric mismatch messages. This keeps malformed `Symbol` and other non-number values on the router's explicit validation path while retaining the existing diagnostics and semantics for numeric but invalid indexes.

This is coordinator-side routing-contract evidence only. It does not count as real browser WebGPU, physical GPU working-set, multi-browser checkpoint relay, worker-loss resume, or production deployment evidence for #167/#158.
