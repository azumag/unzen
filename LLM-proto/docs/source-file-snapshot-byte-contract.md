# Source file snapshot byte contract

`tools/source_file_snapshot.py` is the shared low-level reader used when a source graph or external-data file must be measured or hashed without silently switching filesystem identity.

The helper resolves and pins a regular-file descriptor, compares descriptor metadata before/after reads, verifies that the requested path still resolves to the same file, and rejects bounded reads that exceed the caller's byte ceiling. `hash_file` and `max_bytes` are validated before file I/O.

On platforms that expose `os.O_BINARY` (notably Windows), the descriptor is opened with that flag. Snapshot size accounting and SHA-256 operate on raw file bytes; newline or control-character translation by a text-mode CRT descriptor is not part of the contract. POSIX behavior is unchanged because `getattr(os, "O_BINARY", 0)` contributes no extra flag there.

The caller-specific snapshot readers follow the same raw-byte rule when they consume payload bytes. `tools/multi_segment_onnx.py::_read_source_graph_snapshot()` and `tools/diagnose_multi_segment_budget.py::_read_source_graph_snapshot()` request `O_BINARY` for bounded source-graph snapshots, `tools/prepare_browser_p0.py::sha256_file()` does the same while binding the pinned SmolLM2 P0 source graph to `SOURCE_GRAPH_SHA256`, and `tools/multi_segment_onnx.py::_measure_source_external_file()` requests it before optional source external-data hashing. The latter keeps `hash_file=False` metadata-only: it still does not read payload bytes. Existing path/descriptor identity, symlink-input, mutation, byte-ceiling, and digest contracts remain unchanged.

This is an integrity/reliability boundary for host-side artifact preparation and verification. It does not provide authenticity against an actor that can rewrite both the source bytes and every higher-level digest/evidence record.
