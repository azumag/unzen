# Artifact residency total-byte contract

Tracking: #1640. Parent technical-core work: #167.

`ArtifactResidencyLedger` treats the summed `SegmentArtifact.byteSize` value as exact byte accounting, not an approximate JavaScript number. Each artifact already has to provide a positive safe integer byte size; the constructor also guards the cumulative total before every addition so an inventory that would exceed `Number.MAX_SAFE_INTEGER` is rejected before integer precision can be lost.

The existing diagnostic remains `total artifact byte size exceeds JavaScript safe integer range`. Browser per-segment budget checks still run after this inventory-wide exactness gate, so a cumulative-overflow inventory cannot proceed far enough for a rounded total to influence residency, missing-artifact, coverage, or routing calculations.

Once construction succeeds, every residency and range byte total is a subset of the positive, exact constructor total. Those downstream sums therefore remain within the same safe-integer bound without requiring a separate overflow policy.
