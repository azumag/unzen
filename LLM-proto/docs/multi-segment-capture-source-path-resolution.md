# Multi-segment capture source path resolution

`tools/verify_multi_segment_capture_source.py` re-binds a published #167 capture to the original full ONNX graph and source external-data files. The source files are read-only evidence inputs; this verifier does not execute ONNX Runtime.

## Path-resolution modes

The report exposes `sourcePathResolutionMode` so an audit can distinguish the filesystem guarantees that were actually available.

- `component-anchored-dirfd`: the platform supports `dir_fd`, `O_DIRECTORY`, `O_NOFOLLOW`, and no-follow `stat`. The verifier resolves the caller-supplied source root once, opens that directory, and keeps the directory descriptor for the whole graph/external-data measurement. Before any source payload is hashed, the graph and every external-data path are traversed relative to that anchored descriptor with no-follow checks on each component. Intermediate symlinks and non-directories, final symlinks/non-regular nodes, and filesystem-identity aliases are therefore rejected during the cheap preflight. The later descriptor-pinned hashing repeats the anchored traversal, checks parent directory `(device, inode)` identities and the final file identity again after hashing, and remains the authoritative content/race check.
- `final-component-only`: portable fallback used when those primitives are unavailable. The existing stable file-descriptor hash remains in force for each final graph/external-data file: final symlinks, non-regular files, file mutation, and final inode replacement are rejected. The cheap topology preflight also remains limited to final-component `lstat()` in this mode, so intermediate-directory replacement resistance is not claimed.

The source-root descriptor is shared across the graph and all external-data entries in `component-anchored-dirfd` mode. A source-root replacement during the audit is rejected before publication of a passing report.

Before either path-resolution mode streams source payload bytes, the verifier performs a cheap filesystem-topology preflight over the graph and every canonical external-data location. Every source role must be a non-symlink regular file, and `(st_dev, st_ino)` must be unique across graph↔external and external↔external roles. In `component-anchored-dirfd` mode these identities are obtained through no-follow component traversal from the already-open source-root descriptor, so a malformed later nested path cannot force the verifier to hash a large graph before discovering an intermediate symlink/non-directory. In `final-component-only` mode the portable final-node behavior is retained and no stronger intermediate-component guarantee is implied.

The preflight is deliberately only a fail-fast optimization, not the final topology proof. Each descriptor-pinned source measurement also claims the `(st_dev, st_ino)` identity of the regular file that was actually opened. Those measured identities must remain unique across the graph and all external-data roles. A pathname changed into a hard-link alias after preflight therefore cannot produce a passing report, even when its declared byte count and SHA-256 are identical to the already-measured role. The per-role stable read and, in component-anchored mode, parent/path rechecks still provide the authoritative content and race checks.

## Security boundary

This hardening closes the nested source external-data pathname gap tracked by #366, the source filesystem-alias gap tracked by #969, the fail-fast nested-component gap tracked by #971, and the post-preflight measured-role alias gap tracked by #973. It does not turn the whole capture workflow into a single fd-only transaction, authenticate the evidence producer, prove WebGPU/device-memory behavior, or choose a production physical layout. Those remain separate evidence and architecture concerns under #167.

The split-manifest path validation still rejects absolute paths and parent traversal before any source file is opened. Bundle control files continue to use their existing capture-bundle verification path and are not relaxed by this change.
