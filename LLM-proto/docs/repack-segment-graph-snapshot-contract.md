# Repack segment graph snapshot contract

`tools/prepare_real_split.py::repack_segment_external_data()` derives every source external-data `location`, `offset`, and `length` from the generated segment graph before it opens a repack source or creates/truncates a destination.

The graph is parsed from the shared stable regular-file snapshot boundary rather than by reopening its pathname inside ONNX. The boundary pins one regular-file descriptor with fail-fast flags, verifies the pre-open and opened identity, rechecks the requested pathname before exposing the stream, and checks descriptor/path stability again when parsing completes. Stable symlink inputs remain supported only while the requested path continues to resolve to the same pinned graph.

This means FIFO/device replacement, same-content inode replacement, requested-path retargeting, or mutation during parse is rejected before external-data ranges are accepted for repacking. `load_external_data=False` is unchanged, so the graph parse does not load the external weight blobs into Python memory.

This contract is additive to the existing repack source, destination, alias, and output snapshot protections; it does not change external-data layout, range deduplication, browser artifact policy, or manifest semantics.
