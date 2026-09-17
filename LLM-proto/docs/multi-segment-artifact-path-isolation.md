# Multi-segment artifact path isolation

Budgeted split manifests declare `artifactLayout=per-segment-external-data`. Under that layout, every segment graph and every declared external-data component must resolve to a different filesystem path.

`tools/verify_multi_segment_artifacts.py` enforces this before it can emit a passing integrity report. The uniqueness check is global across the whole manifest, not merely within one segment, so it rejects:

- one segment graph path reused by another segment;
- one external-data path reused by multiple segments;
- a graph path reused as any segment's external-data path;
- lexical path aliases that resolve to the same path under the existing safe-relative-path rules.

All declared graph/external-data paths are preflighted before the first artifact payload is measured. A duplicate or unsafe path in a later segment therefore fails without hashing earlier large artifacts. After this lightweight path-contract gate succeeds, the existing descriptor-pinned size/digest and browser-budget verification proceeds unchanged.

This keeps the measured `browserArtifactBytes` ledger aligned with the manifest's logical browser-cache units. A manifest cannot count one resolved file as two independent artifact components and still pass the standalone integrity gate or the numerical verifiers that invoke that gate.

This check is about declared pathname isolation. It does not claim inode-level isolation for two different hard-link pathnames, nor does it lock paths against replacement after verification. The stricter artifact-snapshot verifier remains the boundary for stable path identity across a verification window.

For #167 this is host-side artifact-integrity hardening only; it is not new evidence of physical WebGPU execution, distinct browser workers, Coordinator relay latency, cache behavior, or worker-loss recovery.
