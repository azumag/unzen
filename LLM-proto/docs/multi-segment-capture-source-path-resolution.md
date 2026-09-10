# Multi-segment capture source path resolution

`tools/verify_multi_segment_capture_source.py` re-binds a published #167 capture to the original full ONNX graph and source external-data files. The source files are read-only evidence inputs; this verifier does not execute ONNX Runtime.

## Path-resolution modes

The report exposes `sourcePathResolutionMode` so an audit can distinguish the filesystem guarantees that were actually available.

- `component-anchored-dirfd`: the platform supports `dir_fd`, `O_DIRECTORY`, `O_NOFOLLOW`, and no-follow `stat`. The verifier resolves the caller-supplied source root once, opens that directory, and keeps the directory descriptor for the whole graph/external-data measurement. Every nested external-data component is then checked and opened relative to the anchored descriptor. Intermediate symlinks and non-directories are rejected. Parent directory `(device, inode)` identities and the final file identity are checked again after hashing, so same-content directory replacement is fail-closed as well.
- `final-component-only`: portable fallback used when those primitives are unavailable. The existing stable file-descriptor hash remains in force for each final graph/external-data file: final symlinks, non-regular files, file mutation, and final inode replacement are rejected. Intermediate-directory replacement resistance is not claimed in this mode.

The source-root descriptor is shared across the graph and all external-data entries in `component-anchored-dirfd` mode. A source-root replacement during the audit is rejected before publication of a passing report.

## Security boundary

This hardening closes the nested source external-data pathname gap tracked by #366. It does not turn the whole capture workflow into a single fd-only transaction, authenticate the evidence producer, prove WebGPU/device-memory behavior, or choose a production physical layout. Those remain separate evidence and architecture concerns under #167.

The split-manifest path validation still rejects absolute paths and parent traversal before any source file is opened. Bundle control files continue to use their existing capture-bundle verification path and are not relaxed by this change.
