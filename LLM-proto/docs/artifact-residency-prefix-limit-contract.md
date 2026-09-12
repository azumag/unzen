# Artifact residency prefix-limit runtime contract

Tracking: #509. Parent technical-core work: #167.

`ArtifactResidencyLedger.residentPrefixLength()` uses `maximumLength` as a routing upper bound for the consecutive cached artifact prefix beginning at a segment. Because callers may cross the TypeScript boundary through assertions or decoded runtime data, malformed values must not be interpreted as an unbounded request.

The runtime contract is:

- `maximumLength` must be a JavaScript `number`.
- negative numbers and `NaN` are rejected before prefix routing is calculated.
- `Number.POSITIVE_INFINITY` intentionally retains the existing unbounded-prefix meaning.
- non-negative finite numbers retain the existing flooring behavior before the upper bound is applied.

In particular, numeric strings, arbitrary strings, booleans, symbols, and other non-number values fail closed. They must never fall through `Number.isFinite()` and acquire the same behavior as positive infinity.

This is coordinator-side routing hardening only. It does not establish real browser-cache residency, WebGPU execution, multi-browser checkpoint relay, worker-loss recovery, or production persistence evidence for #167, and it does not alter the #158 production HOLD boundary.
