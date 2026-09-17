# Multi-segment artifact path isolation

Budgeted split manifests declare `artifactLayout=per-segment-external-data`. Under that layout, every segment graph and every declared external-data component must resolve to a different filesystem path.

`tools/verify_multi_segment_artifacts.py` enforces this before it can emit a passing integrity report. The uniqueness check is global across the whole manifest, not merely within one segment, so it rejects:

- one segment graph path reused by another segment;
- one external-data path reused by multiple segments;
- a graph path reused as any segment's external-data path;
- lexical path aliases that resolve to the same path under the existing safe-relative-path rules.

All declared graph/external-data paths are preflighted before the first artifact payload is measured. A duplicate or unsafe path in a later segment therefore fails without hashing earlier large artifacts. The same fail-fast phase now validates immutable metadata shape for every segment and browser-budget entry: canonical graph/external-data SHA-256 values, non-negative declared byte counts, non-empty tier strings, expected budget-entry indices, and aggregate declared maxima. A malformed declaration in a later segment therefore also fails before any graph or external-data payload is stream-hashed.

After the path/metadata preflight succeeds, descriptor-pinned size/digest measurement and browser-budget comparison remain authoritative. The preflight does not trust declared bytes, hashes, or tiers; it only prevents obviously malformed immutable evidence from forcing expensive 1B-class artifact reads before rejection.

This keeps the measured `browserArtifactBytes` ledger aligned with the manifest's logical browser-cache units. A manifest cannot count one resolved file as two independent artifact components and still pass the standalone integrity gate or the numerical verifiers that invoke that gate.

This check is about declared pathname isolation. It does not claim inode-level isolation for two different hard-link pathnames, nor does it lock paths against replacement after verification. The stricter artifact-snapshot verifier is the stronger boundary: before payload hashing it preflights `(device, inode)` uniqueness, after its first descriptor-pinned measurement it checks the measured identities again, and it then requires every accepted file identity to remain stable across the verification window.

For #167 this is host-side artifact-integrity hardening only; it is not new evidence of physical WebGPU execution, distinct browser workers, Coordinator relay latency, cache behavior, or worker-loss recovery.
