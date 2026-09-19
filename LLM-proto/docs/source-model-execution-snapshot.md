# Source-model execution snapshot

The same-machine numerical verifier records SHA-256 evidence for the full source ONNX graph and every `sourceModel.externalData` entry before it compares the full model with the generated segments. That evidence is only meaningful if ONNX Runtime executes the same filesystem generation that was accepted by the provenance preflight.

## Snapshot boundary

`verify_multi_segment_onnx.py` now creates a temporary execution snapshot beside the requested `--full-model` before the reference `InferenceSession` is constructed.

1. Manifest metadata and source containment are validated first.
2. The graph and every declared external-data file are assigned a `(st_dev, st_ino)` identity before payload hashing.
3. The temporary tree is populated with hard links to exactly those accepted identities, preserving every external-data relative location.
4. The original requested paths are checked again after the links are created. A symlink/path retarget or same-byte replacement with a different inode fails closed.
5. SHA-256/byte-count provenance is measured from the pinned temporary tree.
6. ONNX Runtime opens the temporary graph, not the original pathname. The tree stays alive through reference inference and is removed after the reference session is released.

A path change after the hard links have been pinned cannot redirect the reference session to another inode. Stable symlinked source inputs continue to work because the resolved regular-file identity, rather than the symlink object, is what is pinned.

## I/O and portability

The snapshot uses hard links deliberately. It does **not** copy or embed multi-GiB external-data payloads, so the added payload I/O is metadata-only plus the existing SHA-256 pass. This avoids doubling the read/write volume for 1B-class models merely to close a pathname TOCTOU window.

The temporary directory is created beside `--full-model` so the common graph/external-data layout is on the same filesystem. If any accepted source file cannot be hard-linked into that tree (for example, a cross-device mount or a filesystem without hard-link support), verification fails with an explicit diagnostic rather than silently copying a large payload. The caller can move the evidence bundle to a hard-link-capable single filesystem before retrying.

The snapshot preserves the manifest's lexical external-data locations. ONNX Runtime therefore observes the same relative-location contract as the original source model.

## Scope

This boundary protects the same-machine full-model reference load in `verify_multi_segment_onnx.py`. It does not change provider selection, numerical tolerances, report schema, segment execution order, or browser artifact semantics. Other full-model consumers must opt into the same snapshot boundary separately rather than assuming that provenance verification alone pins a later pathname open.
