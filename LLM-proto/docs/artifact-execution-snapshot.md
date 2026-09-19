# Multi-segment artifact execution snapshot

The direct same-machine numerical verifiers must not treat a successful artifact integrity pass as permission to reopen the original segment pathnames later. A graph or external-data pathname can be replaced after the integrity pass and before ONNX Runtime creates its session, which would make the numerical result describe a different filesystem generation from the one that was verified.

`tools/artifact_execution_snapshot.py` closes that gap for both `verify_multi_segment_onnx.py` and `verify_multi_segment_kv_decode.py`.

## Execution boundary

Before any source-model or split-segment `InferenceSession` is created, the helper performs a fresh stable artifact verification. It retains the accepted file identity for every declared segment graph and external-data file instead of discarding that internal information after producing the public integrity report.

The accepted generation is then pinned as follows:

1. A temporary `.unzen-artifact-execution-*` workspace is created beside the split manifest, on the same filesystem as the generated artifacts.
2. The already-bounded manifest bytes are copied into that workspace. Large model payloads are never copied for snapshot creation.
3. Every declared graph and external-data file is hard-linked into the workspace at the same manifest-relative path. Destination parent directories are prepared first; immediately afterwards, and immediately before `os.link()`, the source pathname must still match the full accepted `st_dev`/`st_ino`/size/`st_mtime_ns`/`st_ctime_ns` identity. This ordering keeps the ctime-inclusive check on the last setup boundary before the link itself changes `st_nlink`/`st_ctime_ns`. A same-byte replacement or metadata-visible in-place mutation during parent setup is therefore not accepted as the verified generation.
4. The verifiers parse the copied manifest relative to the workspace and create all split `InferenceSession` objects from the hard-linked paths. ONNX Runtime therefore resolves external data against the pinned tree rather than reopening the original artifact namespace.
5. Before numerical evidence is allowed to leave the context, every pinned file is rechecked with a bounded metadata fingerprint containing `mode`, `st_dev`, `st_ino`, `st_nlink`, `st_size`, `st_mtime_ns`, and `st_ctime_ns`. This catches in-place writes to the shared inode without a second multi-GiB SHA-256 pass.
6. Cleanup is pathname-safe: the workspace `(st_dev, st_ino)` captured at creation must still occupy the cleanup pathname before recursive removal. If the directory was renamed, replaced, or changed into a symlink, cleanup fails explicitly and does not recursively delete the replacement tree.

## Preserved behavior

The snapshot changes filesystem provenance only. It does not change segment order, hidden-state relay names, KV-cache ownership, comparison tolerances, numerical report schemas, or the sequential session-lifetime policy. The logits verifier still holds only one split-segment session at a time. The KV verifier still reopens segment sessions sequentially for prompt and cached-decode phases, but both phases resolve those sessions inside the same pinned artifact workspace.

The public `artifactIntegrity` report remains the integrity report nested in the stable artifact-snapshot result. No new execution-snapshot metadata is required in downstream report consumers.

## Platform and failure semantics

The bounded-I/O design intentionally requires hard-link support for generated graph and external-data files. If the filesystem or permissions do not permit hard links, the numerical verifier fails closed instead of copying potentially multi-GiB payloads. The execution workspace is created beside the manifest to keep links on the same filesystem.

Stable verification continues to use component-anchored `dir_fd`/`O_NOFOLLOW` path walking where the host supports it, and reports the existing final-component-only mode otherwise. The execution snapshot does not weaken that preflight guarantee.

Hard links pin file object identity but do not make an inode immutable. That is why the post-execution generation fingerprint is mandatory. A detected in-place mutation invalidates the numerical run even if ONNX Runtime itself completed successfully.

Related: #1200, #1192, #1191, #1189, #167.
