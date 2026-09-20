# Execution snapshot capability preflight

Real-model evidence tooling pins source and generated ONNX artifacts into temporary execution snapshots before ONNX Runtime opens them. The snapshot implementation deliberately fails closed when the host cannot express the filesystem operations needed to avoid silently following substituted paths.

Before downloading or opening a large model, run:

```bash
python tools/check_execution_snapshot_capabilities.py --require all --pretty
```

The command is dependency-neutral and only inspects Python/OS filesystem capabilities. Schema `1.2.0` emits a machine-readable JSON object containing:

- `capabilities.componentAnchored`: whether the shared component-by-component `dir_fd`/`O_NOFOLLOW` primitives are available;
- `capabilities.nofollowHardlink`: whether `os.link(..., follow_symlinks=False)` is available;
- `capabilities.nofollowStat`: whether `os.stat(..., follow_symlinks=False)` is available for the stronger component-anchored mode;
- `capabilities.pathnameLstat`: whether `os.lstat()` is available for the pathname identity reads required by every execution-snapshot mode;
- `snapshotPaths.sourceModel`, `legacyTwoSegment`, and `generatedMultiSegment`: whether each execution-snapshot path is usable, which mode it would select, and `missingCapabilities`, the concrete capability blockers when the path is unsupported.

`--require generated`, `--require source`, and `--require legacy` can gate one path. The default `--require all` succeeds only if all three paths are usable. A satisfied requirement exits with status `0`; an unsupported requirement still prints the report but exits with status `1`.

Capability predicates treat missing required OS callables as unsupported rather than dereferencing them while probing. In particular, a reduced Python host without `os.link` cannot advertise no-follow hard-link or component-anchored support, and a host without `os.stat` cannot advertise no-follow stat or component-anchored support. The anchored predicate also rejects hosts missing the other operations it directly relies on (`os.open`, `os.mkdir`, `os.unlink`, `os.fstat`, or `os.close`). This keeps the preflight machine-readable and fail-closed instead of leaking `AttributeError` from capability detection.

All current execution-snapshot implementations additionally capture workspace/source/artifact pathname identity with `lstat()`. Therefore `componentAnchored=true` describes the component-walk primitive only: a host with those primitives but without `pathnameLstat` is still reported `unsupported` for source-model, legacy two-segment, and generated multi-segment snapshots. Missing `os.lstat` never silently falls through to a symlink-following metadata read.

`missingCapabilities` intentionally lists only capabilities that prevent every safe mode for that snapshot path. A usable `component-anchored` or `pathname-fallback` path reports an empty list. If pathname `lstat()` is unavailable, the list contains `pathnameLstat`. If component anchoring is unavailable and the host also cannot express an explicit no-follow hard link, the list contains `nofollowHardlink`. Missing no-follow `stat` by itself is not a fallback blocker, so a host may legitimately report `nofollowStat=false`, select `pathname-fallback`, and still have `missingCapabilities=[]`.

## Current fallback contract

When the component-anchored capability set and pathname `lstat()` are available, all execution-snapshot paths use `component-anchored` mode. That mode still requires the no-follow stat form because final-component metadata is checked relative to an opened parent directory descriptor.

When component anchoring is unavailable, all three execution-snapshot implementations use `lstat()` for pathname-only workspace, parent, file-identity, and execution-fingerprint metadata. Their pathname fallback therefore requires both pathname `lstat()` and an explicit no-follow hard link. A host may report `nofollowStat=false` while source-model, legacy two-segment, and generated multi-segment snapshots all remain usable in `pathname-fallback` mode as long as `pathnameLstat=true` and `nofollowHardlink=true`.

A host without explicit no-follow hard-link support or pathname `lstat()` support is reported as `unsupported`; the tool does not silently downgrade to default-follow filesystem operations. The preflight reuses the same predicates as the runtime boundary and must be kept aligned if those contracts change.

## Evidence boundary

This preflight proves only that the host exposes the filesystem primitives required by the current execution-snapshot implementation. It is environment-readiness evidence, not proof of model correctness or browser execution. In particular, a passing report is not evidence for the remaining #167 requirements such as real `Llama-3.2-1B-Instruct` q4 artifact bytes, physical WebGPU execution, full-vs-multi equivalence, distinct-browser relay/latency, or worker-loss resume.

No credentials, deployment, billing action, or production mutation is performed by this command.
