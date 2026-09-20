# Execution snapshot capability preflight

Real-model evidence tooling pins source and generated ONNX artifacts into temporary execution snapshots before ONNX Runtime opens them. The snapshot implementation deliberately fails closed when the host cannot express the filesystem operations needed to avoid silently following substituted paths.

Before downloading or opening a large model, run:

```bash
python tools/check_execution_snapshot_capabilities.py --require all --pretty
```

The command is dependency-neutral and only inspects Python/OS filesystem capabilities. Schema `1.3.0` emits a machine-readable JSON object containing:

- `capabilities.componentAnchored`: whether the shared component-by-component `dir_fd`/`O_NOFOLLOW` primitives are available;
- `capabilities.nofollowHardlink`: whether `os.link(..., follow_symlinks=False)` is available;
- `capabilities.nofollowStat`: whether `os.stat(..., follow_symlinks=False)` is available for the stronger component-anchored mode;
- `capabilities.pathnameLstat`: whether `os.lstat()` is available for the pathname identity reads required by every execution-snapshot mode;
- `capabilities.snapshotManifestWrite`: whether the generated multi-segment snapshot can create and write its pinned manifest copy using `os.open`/`os.write`/`os.close` with `O_WRONLY|O_CREAT|O_EXCL`;
- `snapshotPaths.sourceModel`, `legacyTwoSegment`, and `generatedMultiSegment`: whether each execution-snapshot path is usable, which mode it would select, and `missingCapabilities`, the concrete capability blockers when the path is unsupported.

`--require generated`, `--require source`, and `--require legacy` can gate one path. The default `--require all` succeeds only if all three paths are usable. A satisfied requirement exits with status `0`; an unsupported requirement still prints the report but exits with status `1`.

Capability predicates treat missing required OS callables as unsupported rather than dereferencing them while probing. In particular, a reduced Python host without `os.link` cannot advertise no-follow hard-link or component-anchored support, and a host without `os.stat` cannot advertise no-follow stat or component-anchored support. The anchored predicate also rejects hosts missing the other operations it directly relies on (`os.open`, `os.mkdir`, `os.unlink`, `os.fstat`, or `os.close`). The generated snapshot additionally rejects hosts that cannot call `os.open`, `os.write`, and `os.close` or do not expose the required create flags. This keeps the preflight machine-readable and fail-closed instead of leaking `AttributeError`/`TypeError` from capability detection or manifest creation.

All current execution-snapshot implementations additionally capture workspace/source/artifact pathname identity with `lstat()`. Therefore `componentAnchored=true` describes the component-walk primitive only: a host with those primitives but without `pathnameLstat` is still reported `unsupported` for source-model, legacy two-segment, and generated multi-segment snapshots. Missing `os.lstat` never silently falls through to a symlink-following metadata read.

The standalone preflight is recommended because it rejects an unsupported host before expensive model preparation begins, but it is not a required correctness step. The shared path-pinning mode selector in `execution_snapshot_internal_paths.py` chooses `component-anchored` when pathname `lstat()` and the anchored primitives are available, `pathname-fallback` when pathname `lstat()` plus explicit no-follow hard links are available, otherwise `unsupported`. The source-model and legacy two-segment context managers call that shared runtime guard before source/artifact verification or snapshot workspace creation. The generated multi-segment context manager calls the same path guard and then the generated-only manifest-write guard before its stable artifact verification. A caller that skips the CLI preflight therefore fails at the same capability boundary instead of doing expensive verification work before discovering that the host cannot construct a complete generated snapshot.

`missingCapabilities` lists capabilities that block the selected snapshot path. A usable path reports an empty list. If pathname `lstat()` is unavailable, the list contains `pathnameLstat`. If component anchoring is unavailable and the host also cannot express an explicit no-follow hard link, the list contains `nofollowHardlink`. Missing no-follow `stat` by itself is not a fallback blocker, so a host may legitimately report `nofollowStat=false`, select `pathname-fallback`, and still have `missingCapabilities=[]` for source-model and legacy snapshots. If only generated manifest creation is unavailable, `sourceModel` and `legacyTwoSegment` remain usable while `generatedMultiSegment` reports `mode=unsupported` with `missingCapabilities=["snapshotManifestWrite"]`.

## Current fallback contract

When the component-anchored capability set and pathname `lstat()` are available, execution-snapshot path pinning uses `component-anchored` mode. That mode still requires the no-follow stat form because final-component metadata is checked relative to an opened parent directory descriptor.

When component anchoring is unavailable, all three execution-snapshot implementations use `lstat()` for pathname-only workspace, parent, file-identity, and execution-fingerprint metadata. Their pathname fallback therefore requires both pathname `lstat()` and an explicit no-follow hard link. A host may report `nofollowStat=false` while source-model, legacy two-segment, and generated multi-segment path pinning remain safe in `pathname-fallback` mode as long as `pathnameLstat=true` and `nofollowHardlink=true`.

Generated multi-segment snapshots have one additional requirement that source-model and legacy snapshots do not: the accepted manifest bytes are copied into the temporary execution tree before the generated graph/external-data hard links are exposed to ORT. That copy requires `snapshotManifestWrite=true`. `O_NOFOLLOW` and `O_CLOEXEC` remain opportunistic flags exactly as in the runtime implementation; they are not reported as blockers because `_snapshot_create_flags()` already treats them as optional.

A host without explicit no-follow hard-link support or pathname `lstat()` support is reported as `unsupported`; the tool does not silently downgrade to default-follow filesystem operations. A host lacking generated manifest-write capability is also reported as `unsupported` for `generatedMultiSegment` only. Lower-level pinning helpers retain their own defensive capability checks so a future internal caller cannot accidentally bypass the fail-closed contract.

## Evidence boundary

This preflight proves only that the host exposes the filesystem primitives required by the current execution-snapshot implementation. It is environment-readiness evidence, not proof of model correctness or browser execution. In particular, a passing report is not evidence for the remaining #167 requirements such as real `Llama-3.2-1B-Instruct` q4 artifact bytes, physical WebGPU execution, full-vs-multi equivalence, distinct-browser relay/latency, or worker-loss resume.

No credentials, deployment, billing action, or production mutation is performed by this command.
