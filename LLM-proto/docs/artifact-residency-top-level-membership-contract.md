# ArtifactResidencyLedger top-level membership contract

Tracking: #680. Parent technical-core work: #167.

`ArtifactResidencyLedger` treats both constructor `SegmentArtifact[]` input and `assertCompatibleSegments()` `SegmentConfig[]` input as runtime trust boundaries. TypeScript `readonly` types do not prevent accessor-backed or Proxy-backed arrays from changing membership while per-entry validation is running.

## Contract

- The top-level array length is captured before any entry field is inspected.
- Each top-level entry reference is then captured by fixed numeric position into an owned plain array.
- Per-entry validation, freezing, sorting, duplicate/index checks, byte accounting, and compatibility checks operate only on those captured references.
- A getter on an earlier artifact or segment config may still mutate the caller-owned source array, but that mutation cannot replace or remove a later member for the in-progress ledger operation.
- Membership capture does not use the caller's `Symbol.iterator`.
- Existing fail-fast field-validation order inside each captured entry remains unchanged.

This closes only the top-level membership TOCTOU boundary. It does not change artifact-size policy, routing preference, production deployment, billing, or the real browser/WebGPU evidence required by #167 and #158.
