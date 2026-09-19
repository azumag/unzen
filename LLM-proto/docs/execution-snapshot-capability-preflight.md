# Execution snapshot capability preflight

Real-model evidence tooling pins source and generated ONNX artifacts into temporary execution snapshots before ONNX Runtime opens them. The snapshot implementation deliberately fails closed when the host cannot express the filesystem operations needed to avoid silently following substituted paths.

Before downloading or opening a large model, run:

```bash
python tools/check_execution_snapshot_capabilities.py --require all --pretty
```

The command is dependency-neutral and only inspects Python/OS filesystem capabilities. It emits a machine-readable JSON object containing:

- `capabilities.componentAnchored`: whether the shared component-by-component `dir_fd`/`O_NOFOLLOW` path is available;
- `capabilities.nofollowHardlink`: whether `os.link(..., follow_symlinks=False)` is available;
- `capabilities.nofollowStat`: whether `os.stat(..., follow_symlinks=False)` is available;
- `snapshotPaths.sourceModel`, `legacyTwoSegment`, and `generatedMultiSegment`: whether each execution-snapshot path is usable and which mode it would select.

`--require generated`, `--require source`, and `--require legacy` can gate one path. The default `--require all` succeeds only if all three paths are usable. A satisfied requirement exits with status `0`; an unsupported requirement still prints the report but exits with status `1`.

## Current fallback contract

When the component-anchored capability set is available, all execution-snapshot paths use `component-anchored` mode.

When it is unavailable, the shared source-model and legacy two-segment path currently requires both explicit no-follow hard links and explicit no-follow final-file stat operations. The generated multi-segment path already uses `lstat()` for pathname metadata, so its pathname fallback only requires an explicit no-follow hard link. The preflight reuses the same predicates as the runtime boundary and must be kept aligned if those contracts change.

A host without the required capabilities is reported as `unsupported`; the tool does not silently downgrade to default-follow filesystem operations.

## Evidence boundary

This preflight proves only that the host exposes the filesystem primitives required by the current execution-snapshot implementation. It is environment-readiness evidence, not proof of model correctness or browser execution. In particular, a passing report is not evidence for the remaining #167 requirements such as real `Llama-3.2-1B-Instruct` q4 artifact bytes, physical WebGPU execution, full-vs-multi equivalence, distinct-browser relay/latency, or worker-loss resume.

No credentials, deployment, billing action, or production mutation is performed by this command.
