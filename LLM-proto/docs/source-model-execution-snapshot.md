# Source-model execution snapshot

The same-machine numerical verifiers record SHA-256 evidence for the full source ONNX graph and every `sourceModel.externalData` entry before they compare the full model with generated segments. That evidence is only meaningful if ONNX Runtime executes the same filesystem generation that was accepted by provenance preflight.

## Snapshot boundary

`tools/source_model_execution_snapshot.py` provides a dependency-neutral temporary execution snapshot beside the requested `--full-model` before a reference `InferenceSession` is constructed. The budgeted multi-segment logits verifier, the prompt + cached KV-decode verifier, and the legacy two-segment verifier all use the same hard-link/fingerprint strategy. The KV verifier keeps one snapshot-backed full-model session alive across both prompt prefill and the subsequent cached decode step; the legacy verifier keeps the snapshot alive for its complete full-model reference session, then releases it before loading the split segments so sequential session loading is preserved.

1. Manifest metadata and source containment are validated first.
2. The graph and every declared external-data file are assigned a `(st_dev, st_ino)` identity before payload hashing.
3. The requested model's parent directory is resolved once immediately before workspace creation. The temporary tree is created through that resolved parent, and the resulting workspace path is resolved before it is retained for all later snapshot writes and cleanup. A later retarget of a caller-visible parent symlink therefore cannot redirect the workspace or its removal. The workspace directory's own `(st_dev, st_ino)` identity is captured immediately after creation.
4. The temporary tree is populated with hard links to exactly the accepted source identities, preserving every external-data relative location.
5. The original requested paths are checked again after the links are created. A symlink/path retarget or same-byte replacement with a different inode fails closed.
6. A metadata generation fingerprint (`mode`, device/inode, link count, size, mtime and ctime) is captured for every pinned file. SHA-256/byte-count provenance is then measured from the pinned temporary tree and the fingerprints are checked again.
7. ONNX Runtime opens the temporary graph, not the original pathname. The tree stays alive through the complete reference inference phase. For KV verification that means both prompt prefill and cached decode run through the same pinned full-model session.
8. The same fingerprints are checked after reference inference and before cleanup. This catches an in-place write to the shared hard-link inode even when pathname identity never changed. Before pathname-based recursive removal, the workspace path is checked again against the captured directory identity. A missing, symlinked, or replaced workspace fails cleanup explicitly and the replacement object is not recursively removed. Cleanup errors are not silently ignored.

A path change after the hard links have been pinned cannot redirect the reference session to another inode. Stable symlinked source inputs continue to work because the resolved regular-file identity, rather than the symlink object, is what is pinned. Hard links do share writable inode contents, so the before/after generation fingerprint is required in addition to pathname pinning; evidence is rejected if the pinned generation changes while ONNX Runtime can observe it. Retargeting a parent-directory symlink after workspace creation is also fail-closed by the source path-identity check without changing which temporary directory is later removed. If the workspace entry itself is renamed or replaced, the verifier prefers an explicit cleanup-integrity failure over deleting whatever object now occupies the old pathname.

## I/O and portability

The snapshot uses hard links deliberately. It does **not** copy or embed multi-GiB external-data payloads, so the added payload I/O is metadata-only plus the existing SHA-256 pass. The post-execution guard is also metadata-only; it does not add a second multi-GiB hashing pass. This avoids doubling the read/write volume for 1B-class models merely to close a pathname TOCTOU window.

The temporary directory is created beside the resolved parent identity of `--full-model` so the common graph/external-data layout is on the same filesystem while cleanup does not re-traverse a mutable caller-visible parent symlink. Its directory identity is revalidated immediately before recursive deletion, so a replaced workspace path is never accepted as the cleanup target. If the original workspace has been renamed away, automatic cleanup intentionally refuses to guess its new pathname; the verification fails explicitly instead of risking deletion of an unrelated replacement tree. If any accepted source file cannot be hard-linked into that tree (for example, a cross-device mount or a filesystem without hard-link support), verification fails with an explicit diagnostic rather than silently copying a large payload. The caller can move the evidence bundle to a hard-link-capable single filesystem before retrying.

The snapshot preserves the manifest's lexical external-data locations. ONNX Runtime therefore observes the same relative-location contract as the original source model.

## Legacy two-segment verifier

`tools/verify_split_onnx.py` now validates the legacy `unzen-real-two-segment-onnx` manifest's `sourceModel.sha256` and every declared external-data byte count/digest before it creates the reference ORT session. The reference session is opened from the verified snapshot path, not the original `--full-model` pathname. The snapshot is destroyed after the reference run and before `segment0` is opened, so provider selection, tolerances, boundary routing, report schema, and the existing sequential full-model -> segment0 -> segment1 loading contract do not change.

A source provenance/snapshot failure occurs before any ORT session is created. Same-byte pathname retargets, different-inode replacements, and in-place graph/external-data mutation while the reference session can observe the pinned files therefore fail closed instead of producing numerical evidence for a generation different from the one recorded in the split manifest.

## Scope

This boundary protects the full-model reference loads in `verify_multi_segment_onnx.py`, `verify_multi_segment_kv_decode.py`, and `verify_split_onnx.py`. It does not change provider selection, numerical tolerances, report schemas, KV cache ownership, segment execution order, or browser artifact semantics. Other full-model consumers must opt into the same snapshot boundary separately rather than assuming that provenance verification alone pins a later pathname open.
