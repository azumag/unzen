# Two-segment verification manifest snapshot

`tools/verify_split_onnx.py` uses `split-manifest.json` as control input for the same-machine numerical correctness gate. Boundary tensor names and the logits output determine how the full model and the two generated ONNX segments are executed, so those routing values must come from one stable filesystem object.

The public `verify_split()` boundary first validates and snapshots its runtime controls before touching the manifest or creating an ONNX Runtime session. Token IDs must be non-negative integers and are consumed exactly once, the provider must be a non-empty name, KV-head/head-size values must be positive non-boolean integers, and `atol` / `rtol` must be finite non-negative numbers. This keeps `NaN` / infinite tolerances or malformed cache dimensions from weakening the numerical gate or triggering expensive model work before configuration failure.

After that runtime preflight, the verifier opens the manifest as a non-symlink regular file, binds the pathname metadata to the opened descriptor, reads all bytes from that descriptor, verifies that descriptor metadata did not change during the read, and then rechecks that the pathname still names the same file. UTF-8 decoding and JSON parsing happen only after those checks and still before any ONNX Runtime session is created.

A pathname replacement between the initial check and `open()`, an in-place mutation while bytes are being read, a symlink/directory/non-regular input, malformed UTF-8/JSON, or malformed runtime controls therefore fails before model execution begins. Valid runtime values and manifest structure remain otherwise unchanged.

## Generated split-artifact provenance

The legacy verifier treats the prepared `unzen-real-two-segment-onnx` manifest as the authority for the two generated segments as well as for routing metadata. `schemaVersion=1.0.0`, the legacy manifest kind, and `artifactLayout=per-segment-external-data` are required. The caller-provided `--segment0` and `--segment1` pathnames remain part of the CLI for compatibility, but each must resolve to the corresponding manifest-declared `segments[0/1].path` object.

Before split inference starts, `tools/legacy_two_segment_artifact_execution_snapshot.py` validates path safety, regular-file identity, portable aliases, CLI/manifest segment binding, and manifest SHA-256/byte declarations. The accepted graph and external-data identities are then hard-linked into a temporary directory beside the manifest. A full `mode/dev/ino/nlink/size/mtime_ns/ctime_ns` pre-link fingerprint rejects lexical retargets or metadata-visible object mutation while the tree is being pinned.

The manifest byte proof is performed **from that pinned execution tree**, not from the original pathnames. Every pinned segment graph is measured against its manifest SHA-256 and every pinned external-data component against both byte count and SHA-256. One execution-lifetime fingerprint set surrounds the complete measurement pass, so a linked inode that changes while another artifact is being hashed also fails closed. The original lexical paths are rechecked after measurement to ensure they still name the identities that were pinned. This ordering binds the manifest digest evidence directly to the same hard-linked files ONNX Runtime will open rather than relying on metadata alone across a hash-to-link gap.

ONNX Runtime opens only the graph paths inside the pinned tree, preserving each segment's relative external-data layout without copying multi-GiB payloads. The temporary tree remains live across the sequential segment0 -> segment1 execution and keeps the same `mode/dev/ino/nlink/size/mtime_ns/ctime_ns` fingerprints for every linked artifact. An in-place graph or external-data mutation, including one made through the original pathname while ORT can still observe the inode, invalidates the verification result when the execution context exits.

Cleanup is identity-bound as well. The temporary workspace's `(st_dev, st_ino)` is captured at creation and checked before recursive removal. If the workspace pathname has been renamed or replaced, cleanup fails closed instead of deleting the replacement tree.

The full-model reference uses the separate source-model provenance/snapshot contract documented in `source-model-execution-snapshot.md`; generated split-artifact provenance does not replace or weaken that source check. Provider selection, tolerances, boundary routing, report schema, and the sequential full-model -> segment0 -> segment1 session-lifetime contract remain unchanged.

Regression coverage is in `tools/tests/test_verify_split_onnx_manifest_snapshot.py`, `tools/tests/test_verify_split_onnx_runtime_preflight.py`, `tools/tests/test_verify_split_onnx_source_execution_snapshot.py`, and `tools/tests/test_legacy_two_segment_artifact_execution_snapshot.py`.
