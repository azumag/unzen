# Generated snapshot manifest-write capability

Generated multi-segment execution snapshots copy the already-verified `split-manifest.json` bytes into the temporary execution workspace before ONNX Runtime opens the pinned graph/external-data hard links. That copy is a generated-only requirement; source-model and legacy two-segment execution snapshots do not write a copied manifest.

`tools/execution_snapshot_manifest_write.py` owns the dependency-neutral capability predicate used by both the standalone execution-snapshot preflight and the generated runtime guard.

A host is considered manifest-write capable only when:

- `os.open`, `os.write`, and `os.close` are callable;
- `os.open` advertises descriptor-relative (`dir_fd`) support, because the runtime always creates the copied manifest relative to the already-opened accepted workspace generation;
- `O_WRONLY`, `O_CREAT`, and `O_EXCL` exist as real integer flag values;
- if `O_NOFOLLOW` or `O_CLOEXEC` attributes exist, they are real integer flag values rather than reduced-runtime placeholders.

`O_NOFOLLOW` and `O_CLOEXEC` remain optional: a Python/OS implementation that does not expose either attribute can still satisfy this capability. The fail-closed rule only rejects malformed present attributes such as `None`, because `_snapshot_create_flags()` would otherwise attempt to OR that placeholder into the open flags after artifact verification.

This keeps the generated manifest-write predicate aligned with the operation that `_write_snapshot_manifest()` actually performs and prevents a reduced host from passing capability preflight only to fail later with a raw `TypeError` or unsupported `dir_fd` call.

The machine-readable execution-snapshot capability report keeps the existing schema shape and `snapshotManifestWrite` field; this change only makes that predicate more accurate. It does not change artifact paths, manifest bytes, segment layout, numerical tolerances, browser execution, deployment, credentials, or billing.

Related: #1251, #167.
