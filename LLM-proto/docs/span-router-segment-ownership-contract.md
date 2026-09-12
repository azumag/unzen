# SpanRouter segment ownership contract

Tracking: #521. Parent technical-core work: #167.

`SpanRouter` treats supplied segment geometry as constructor input, not as mutable routing state owned by the caller.

Contract:

- `segments` must be an actual array at runtime.
- The router snapshots and freezes the array and each `SegmentConfig` object before storing them.
- Index/VRAM validation and optional `ArtifactResidencyLedger` compatibility checks run against that same snapshot.
- Mutating, appending to, or removing from the caller-owned array after construction cannot change span capacity or route coverage.
- Existing cache-locality, tier, capacity, and backtracking preferences are unchanged.

This is coordinator-side routing-contract evidence only. It does not count as real browser WebGPU, physical GPU working-set, multi-browser checkpoint relay, worker-loss resume, or production deployment evidence for #167/#158.
