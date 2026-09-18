# Source file snapshot byte contract

`tools/source_file_snapshot.py` is the shared low-level reader used when a source graph or external-data file must be measured or hashed without silently switching filesystem identity.

The helper resolves and pins a regular-file descriptor, compares descriptor metadata before/after reads, verifies that the requested path still resolves to the same file, and rejects bounded reads that exceed the caller's byte ceiling. `hash_file` and `max_bytes` are validated before file I/O.

On platforms that expose `os.O_BINARY` (notably Windows), the descriptor is opened with that flag. Snapshot size accounting and SHA-256 operate on raw file bytes; newline or control-character translation by a text-mode CRT descriptor is not part of the contract. POSIX behavior is unchanged because `getattr(os, "O_BINARY", 0)` contributes no extra flag there.

This is an integrity/reliability boundary for host-side artifact preparation and verification. It does not provide authenticity against an actor that can rewrite both the source bytes and every higher-level digest/evidence record.
