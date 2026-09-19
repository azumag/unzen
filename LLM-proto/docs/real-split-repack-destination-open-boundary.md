# Real-split repack destination open boundary

`tools/prepare_real_split.py::_open_repack_destination()` deliberately avoids truncating a destination until the opened descriptor has been validated as a single-link regular file.

The destination descriptor is opened with `O_NOFOLLOW`, `O_NONBLOCK`, and `O_CLOEXEC` when the host exposes those flags. `O_NONBLOCK` is a fail-fast filesystem boundary: a path that was acceptable during preflight can still be replaced by a FIFO or device before `os.open()`. A blocking write-only FIFO open can otherwise wait indefinitely before the post-open `fstat()` check is reached.

After a descriptor is obtained, the helper still requires a regular file with `st_nlink == 1` and only then calls descriptor-based `ftruncate()`. Therefore a raced special-file destination cannot be truncated or written as a repacked payload, while normal regular-file repacks retain their existing behavior.

`O_CLOEXEC` prevents the short-lived repack descriptor from being inherited across exec. This change does not alter external-data layout, range selection, publication semantics, or any production deployment behavior.
