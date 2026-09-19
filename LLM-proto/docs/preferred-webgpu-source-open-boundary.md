# Preferred WebGPU probe source open boundary

The preferred endpoint WebGPU preparation path pins the source external-data file before materializing any probe payload. The same helper is also reused by the five-way endpoint WebGPU preparation path.

The requested path is first required to be a non-symlink regular file with the pinned byte size. Its final descriptor open requests `O_NOFOLLOW`, `O_NONBLOCK`, `O_CLOEXEC`, and `O_BINARY` where those flags are available. The opened descriptor must still be a regular file and must match the identity captured by the pre-open `lstat()` before any source digest is accepted.

`O_NONBLOCK` prevents a path-replacement race from turning preparation into an unbounded wait. A regular source can be replaced after preflight but before `os.open()`; if the replacement is a FIFO or another special file, descriptor validation must be reached without blocking. The descriptor remains pinned through source hashing and payload materialization, and the requested source path is checked again before the descriptor is released.

`O_BINARY` keeps the pinned SHA-256 contract tied to exact persisted bytes on platforms whose CRT distinguishes text and binary descriptors. CRLF sequences and control bytes such as `0x1a` are therefore hashed without text translation.

This boundary hardening does not change physical-artifact geometry, execution-tile selection, payload offsets, report schema, or the diagnostic-only status of the WebGPU probe.
