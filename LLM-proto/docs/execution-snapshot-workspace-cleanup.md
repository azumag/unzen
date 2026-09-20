# Shared execution-snapshot workspace identity and cleanup

Source-model, legacy two-segment, and generated multi-segment execution snapshots all create temporary hard-link trees and capture the workspace `(st_dev, st_ino)` immediately after creation.

Workspace directory identity is owned by `tools/execution_snapshot_internal_paths.py::workspace_identity()`. It uses `os.lstat()`, rejects symlinks and non-directories, and returns the captured `(st_dev, st_ino)`. Generated multi-segment pinning delegates directly; source-model and legacy two-segment pinning retain thin `_snapshot_workspace_identity()` adapters so their existing failure wording remains stable.

Final cleanup is owned by `tools/execution_snapshot_internal_paths.py::remove_verified_workspace()`. Callers retain thin `_remove_verified_snapshot_root()` wrappers so existing test seams and path-specific error labels remain stable.

Cleanup is generation-bound rather than a pathname check followed by `shutil.rmtree()`. The shared helper:

- opens the workspace parent directory and the workspace itself with `O_DIRECTORY|O_NOFOLLOW`;
- validates the opened workspace descriptor against the captured `(st_dev, st_ino)`;
- recursively removes children relative to the already-open directory descriptors;
- validates each opened child directory before removing its directory entry;
- rechecks that the workspace name still refers to the captured root generation before the final `rmdir`.

If the workspace pathname is renamed or replaced after the root descriptor is opened, recursive deletion continues only through the captured descriptor. A replacement tree or symlink installed at the original workspace pathname is therefore not traversed or recursively deleted. The final root-name identity check fails closed with `<label> workspace changed before cleanup: <path>` instead of applying recursive deletion to the replacement.

The deterministic race regression swaps the workspace after its descriptor has been accepted but before recursive deletion begins. It verifies that the original opened generation is the only tree traversed and that replacement contents survive.

This stronger cleanup requires descriptor-relative filesystem primitives: `os.open` and `os.stat` with `dir_fd`, `os.stat(..., follow_symlinks=False)`, `os.scandir(fd)`, descriptor-relative `os.unlink`/`os.rmdir`, `os.fstat`, `os.close`, plus `O_DIRECTORY` and `O_NOFOLLOW`. `generation_bound_cleanup_supported()` reports that capability. Every public execution-snapshot runtime checks it before verification or workspace creation, and the standalone capability preflight reports it as `capabilities.generationBoundCleanup`. There is no weaker pathname-recursive cleanup fallback.

Each caller still validates recorded nested-parent identities immediately before cleanup. The shared workspace helper does not replace or weaken those checks; it centralizes root identity capture and final generation-bound removal.

These changes affect host filesystem readiness only. Artifact/evidence schemas, hard-link pinning, execution fingerprints, and ONNX Runtime inputs are unchanged.
