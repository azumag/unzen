# Browser P0 artifact-size snapshot boundary

`tools/prepare_browser_p0.py` enforces the browser shard budget from observed graph and segment-local external-data sizes. Those byte counts now come from the same contained filesystem objects that pass the artifact-path validation rather than from a later pathname-only `stat()`.

For each generated artifact, the existing cross-platform relative-path and output-directory containment checks run first. The resulting resolved in-tree pathname is then snapshotted, opened read-only with nonblocking/no-follow flags where supported, required to remain a regular file, and measured through `fstat()`. The resolved pathname is rechecked before the descriptor is closed. Replacement between containment validation and open, a non-regular replacement such as a FIFO, or pathname identity drift during measurement fails closed.

Stable symlink inputs remain compatible because containment validation resolves the symlink once and measurement is pinned to that validated target. Retargeting the original symlink after validation therefore cannot switch the bytes charged to the browser budget.

The manifest-declared external-data byte comparison and preferred/normal/absolute tier semantics are unchanged. This is host-side P0 artifact accounting hardening only; it does not select a segmentation/layout/runtime/cache/dispatcher design and is not new real Llama-3.2-1B WebGPU evidence for #167. #158 remains outside this boundary and stays on HOLD.

Regression coverage lives in `tools/tests/test_prepare_browser_p0_artifact_size_snapshot.py` alongside the existing path-pinning tests.
