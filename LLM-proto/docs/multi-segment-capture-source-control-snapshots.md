# Multi-segment capture source control-file snapshots

`tools/verify_multi_segment_capture_source.py` performs a post-publication audit that re-binds a captured #167 run to the caller-supplied original ONNX graph and source external-data files.

The base bundle verifier already establishes accepted SHA-256 identities for `run-summary.json`, the split manifest, and the persisted numerical evidence. The source audit must consume the exact bytes represented by those accepted identities when it reparses the control JSON; parsing one pathname snapshot and hashing a later pathname snapshot would leave a TOCTOU gap.

## Stable read contract

The source audit therefore uses the same bounded stable JSON reader as the source-provenance audit for all three control files:

- `run-summary.json`
- the split manifest selected by the run summary
- the same-machine numerical evidence selected by the run summary

Each file must remain a non-symlink regular file across `lstat -> open -> fstat -> bounded read -> fstat -> lstat`. The reader rejects replacement, in-read mutation, final-component symlinks, non-regular files, input growth beyond the configured 16 MiB bound, invalid UTF-8, and invalid JSON.

The SHA-256 returned from that same read is compared directly with the digest accepted by `verify_multi_segment_capture_bundle.py`. The source audit no longer reparses a control file and then performs a separate pathname hash to decide whether those parsed bytes belong to the accepted bundle snapshot.

Manifest and evidence paths retain their final path component until the stable reader opens them. This is important because resolving the final component first would erase evidence that the bundle pathname itself had been replaced by a symlink.

## Evidence boundary

This hardening only strengthens the diagnostic post-publication audit. It does not authenticate the evidence producer, make capture execution a single fd-only transaction, prove WebGPU or GPU device-memory behavior, prove multi-browser checkpoint relay/resume, or choose a production physical layout. Those remain separate #167 evidence and architecture questions.
