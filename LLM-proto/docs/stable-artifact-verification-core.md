# Shared stable artifact-verification core

The public multi-segment artifact snapshot verifier and the execution-snapshot pinning path intentionally use the same stable verification implementation.

`verify_multi_segment_artifact_snapshot._verify_artifact_snapshot_stable()` is the internal boundary. It performs the manifest snapshot read, declared artifact enumeration, hard-link alias preflight, before/after byte and SHA-256 measurement, underlying integrity verification, root/parent/file identity checks, and final stable-generation decision exactly once. Its result contains three pieces of data:

- the existing public diagnostic report, unchanged in schema and semantics;
- the exact manifest bytes accepted by the stable verification pass;
- the measured artifact entries, including file identities and parent identities needed by execution pinning.

`verify_artifact_snapshot()` is now only the public-report adapter. `artifact_execution_snapshot._verify_execution_boundary()` delegates directly to the same internal result and then hard-links those accepted identities into the execution tree. The execution path must not re-run an independent verifier or reopen a later pathname generation before pinning.

This split is deliberate: public callers keep the existing report contract, while execution pinning can retain private provenance metadata without duplicating verification logic. Any future change to mutation detection, failure ordering, alias rejection, path-resolution mode, or integrity binding should be implemented in the shared stable core so both callers fail closed in the same way.

The shared-core regression tests cover a valid control, direct delegation, and same-content inode replacement during the underlying integrity verifier. The mutation must raise the same stable-verification error through both the public verifier and the execution boundary.
