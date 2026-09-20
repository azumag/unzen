# Shared execution-snapshot workspace identity and cleanup

Source-model, legacy two-segment, and generated multi-segment execution snapshots all create temporary hard-link trees and capture the workspace `(st_dev, st_ino)` immediately after creation.

Workspace directory identity is owned by `tools/execution_snapshot_internal_paths.py::workspace_identity()`. It uses `os.lstat()`, rejects symlinks and non-directories, and returns the captured `(st_dev, st_ino)`. Generated multi-segment pinning delegates directly; source-model and legacy two-segment pinning retain thin `_snapshot_workspace_identity()` adapters so their existing failure wording remains stable.

The final pathname-based recursive removal is owned by `tools/execution_snapshot_internal_paths.py::remove_verified_workspace()`. Callers retain thin `_remove_verified_snapshot_root()` wrappers so existing test seams and path-specific error labels remain stable.

Before `shutil.rmtree()` the shared cleanup helper performs `os.lstat()` on the workspace pathname and requires all of the following:

- the pathname still exists;
- it still names a directory rather than a symlink or another filesystem object;
- `(st_dev, st_ino)` still matches the identity captured for the temporary workspace.

A missing, non-directory, symlinked, or replaced pathname raises `<label> workspace changed before cleanup: <path>` and recursive removal is not attempted. This prevents a replacement tree from being deleted if the temporary workspace pathname is exchanged after pinning.

Each caller still validates recorded nested-parent identities immediately before cleanup. The shared workspace helper does not replace or weaken those checks; it only centralizes the root-identity capture/check primitives and final recursive removal.

These sharing changes are ownership-only. Artifact/evidence schemas, hard-link pinning, execution fingerprints, ONNX Runtime inputs, and supported host modes are unchanged.
