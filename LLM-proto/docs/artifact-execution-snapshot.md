# Multi-segment artifact execution snapshot

The direct same-machine numerical verifiers must not treat a successful artifact integrity pass as permission to reopen the original segment pathnames later. A graph or external-data pathname can be replaced after the integrity pass and before ONNX Runtime creates its session, which would make the numerical result describe a different filesystem generation from the one that was verified.

`tools/artifact_execution_snapshot.py` closes that gap for both `verify_multi_segment_onnx.py` and `verify_multi_segment_kv_decode.py`.

## Execution boundary

Before any source-model or split-segment `InferenceSession` is created, the helper performs a fresh stable artifact verification. It retains the accepted file identity for every declared segment graph and external-data file instead of discarding that internal information after producing the public integrity report.

The accepted generation is then pinned as follows:

1. A temporary `.unzen-artifact-execution-*` workspace is created beside the split manifest, on the same filesystem as the generated artifacts. Its `(st_dev, st_ino)` is captured immediately and remains the authoritative workspace identity for every later manifest write, hard-link pin, validation, and cleanup decision; a directory that subsequently appears at the same pathname is never recaptured as the new accepted workspace.
2. The already-bounded manifest bytes are copied into that accepted workspace. Large model payloads are never copied for snapshot creation. On hosts with `dir_fd`, `O_DIRECTORY`, and `O_NOFOLLOW` support, manifest creation is issued relative to an opened workspace directory handle whose identity matches the original capture, using exclusive creation and no-follow semantics. A workspace replacement before the manifest copy therefore fails before the replacement tree receives the copied manifest.
3. Every declared graph and external-data file is hard-linked into the workspace at the same manifest-relative path. Every pin uses the same workspace identity captured immediately after `mkdtemp()`; `_link_verified_artifact_file()` does not recapture whatever directory later occupies the workspace pathname. On hosts with `dir_fd`, `O_DIRECTORY`, and `O_NOFOLLOW` support, nested destination parents are created and opened component-by-component from the accepted workspace directory handle, and the hard link is issued relative to the final parent handle instead of re-traversing a mutable pathname. The opened parent chain is revalidated against the workspace immediately after the link and again before evidence leaves the context; if a parent was renamed, replaced, or substituted with a symlink, the just-created link is removed through the still-open parent handle and the run fails closed. Destination parent identities are also retained for cleanup-time validation so a substituted nested tree is not recursively removed as though it were the accepted workspace. After destination setup, and immediately before `os.link()`, the source pathname must still match the full accepted `st_dev`/`st_ino`/size/`st_mtime_ns`/`st_ctime_ns` identity. This ordering keeps the ctime-inclusive check on the last source setup boundary before the link itself changes `st_nlink`/`st_ctime_ns`. A same-byte replacement or metadata-visible in-place mutation during parent setup is therefore not accepted as the verified generation.
4. The verifiers parse the copied manifest relative to the workspace and create all split `InferenceSession` objects from the hard-linked paths. ONNX Runtime therefore resolves external data against the pinned tree rather than reopening the original artifact namespace.
5. Before numerical evidence is allowed to leave the context, every pinned file is rechecked with a bounded metadata fingerprint containing `mode`, `st_dev`, `st_ino`, `st_nlink`, `st_size`, `st_mtime_ns`, and `st_ctime_ns`. This catches in-place writes to the shared inode without a second multi-GiB SHA-256 pass. Recorded nested-parent identities are revalidated as well, so a later parent substitution invalidates the run even if the replacement happens to expose the same file inode.
6. Cleanup is pathname-safe: the workspace `(st_dev, st_ino)` captured at creation must still occupy the cleanup pathname before recursive removal, and any recorded nested destination parent must still have the same directory identity. If the workspace or a recorded nested parent was renamed, replaced, or changed into a symlink, cleanup fails explicitly and does not recursively delete the replacement tree.

## Preserved behavior

The snapshot changes filesystem provenance only. It does not change segment order, hidden-state relay names, KV-cache ownership, comparison tolerances, numerical report schemas, or the sequential session-lifetime policy. The logits verifier still holds only one split-segment session at a time. The KV verifier still reopens segment sessions sequentially for prompt and cached-decode phases, but both phases resolve those sessions inside the same pinned artifact workspace.

The public `artifactIntegrity` report remains the integrity report nested in the stable artifact-snapshot result. No new execution-snapshot metadata is required in downstream report consumers.

## Platform and failure semantics

The bounded-I/O design intentionally requires hard-link support for generated graph and external-data files. If the filesystem or permissions do not permit hard links, the numerical verifier fails closed instead of copying potentially multi-GiB payloads. The execution workspace is created beside the manifest to keep links on the same filesystem.

Stable verification continues to use component-anchored `dir_fd`/`O_NOFOLLOW` path walking where the host supports it, and reports the existing final-component-only mode otherwise. The execution snapshot now uses the same style of component-anchored handling for the root manifest and nested destination parents when `os.open`, `os.mkdir`, `os.link`, `os.stat`, and `os.unlink` all support `dir_fd` and the host exposes `O_DIRECTORY`/`O_NOFOLLOW`. On platforms without those primitives, the helper retains the portable pathname fallback, repeatedly rejects symlink/non-directory parent components, and revalidates the original workspace identity before/after the bounded operation; such hosts do not claim a race-free component-anchored destination guarantee.

Hard links pin file object identity but do not make an inode immutable. That is why the post-execution generation fingerprint is mandatory. A detected in-place mutation invalidates the numerical run even if ONNX Runtime itself completed successfully.

Related: #1206, #1202, #1200, #1192, #1191, #1189, #167.
