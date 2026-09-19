# Embedding composition source open boundary

The endpoint embedding-composition CPU probe keeps the full tied-weight external-data descriptor open while it hashes the pinned source and exposes that same descriptor through `/dev/fd` to ONNX Runtime. The source path is therefore treated as untrusted until the descriptor has been pinned and validated.

Before opening, the resolved external-data path must still be a non-symlink regular file. The final descriptor open requests `O_NOFOLLOW`, `O_NONBLOCK`, `O_CLOEXEC`, and `O_BINARY` where available. The opened descriptor must remain a regular file and match the pre-open identity before hashing or ORT use is allowed.

`O_NONBLOCK` closes the regular-file-to-FIFO/device replacement race between the metadata snapshot and `os.open()`: a hostile or concurrent replacement must reach descriptor validation without turning the probe into an unbounded wait. `O_BINARY` keeps SHA-256 tied to the exact persisted source bytes on platforms that distinguish text and binary descriptors.

The descriptor remains pinned through the full-weight reference execution, and the path/descriptor identity is checked again before the result is accepted. This hardening does not select the 4-way/8-tile layout, alter token routing or numerical comparison, or change the diagnostic-only status of the probe.
