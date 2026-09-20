# Read-only component-walk capability

The multi-segment artifact-snapshot verifier and capture-source verifier share one dependency-neutral capability predicate in `tools/readonly_component_walk.py` before selecting `component-anchored-dirfd` path resolution.

The read-only predicate intentionally requires only the operations used by those verifiers:

- `os.open` and `os.stat` exist and support `dir_fd`;
- `os.stat` supports `follow_symlinks=False`;
- `O_DIRECTORY` and `O_NOFOLLOW` are available.

If a reduced Python host does not expose `os.open` or `os.stat` at all, the predicate reports the component-walk path as unsupported instead of raising while probing capabilities. Callers then retain their existing fail-closed fallback behavior.

It deliberately does **not** require `mkdir`, `link`, or `unlink`. Those are write-path requirements owned by the stricter execution-snapshot capability checks in `execution_snapshot_internal_paths.py`.

Both verifiers keep their existing private `_component_walk_supported()` wrappers for compatibility with focused tests, but the wrappers delegate to the shared predicate. Therefore capability selection can no longer drift independently between artifact-snapshot and capture-source verification while their existing `component-anchored-dirfd` versus `final-component-only` behavior remains unchanged.
