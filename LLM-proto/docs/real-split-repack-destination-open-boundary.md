# Real-split repack destination open boundary

`tools/prepare_real_split.py::_open_repack_destination()` deliberately avoids truncating a destination until the opened descriptor has been validated as a single-link regular file.

The destination descriptor is opened with `O_NOFOLLOW`, `O_NONBLOCK`, and `O_CLOEXEC` when the host exposes those flags. `O_NONBLOCK` is a fail-fast filesystem boundary: a path that was acceptable during preflight can still be replaced by a FIFO or device before `os.open()`. A blocking write-only FIFO open can otherwise wait indefinitely before the post-open `fstat()` check is reached.

On hosts with `dir_fd`, `O_DIRECTORY`, and `O_NOFOLLOW` support, the repack path additionally pins the canonical destination parent below the model directory before any source copy begins. The output-root descriptor is identity-checked, nested parent components are opened relative to already-pinned directory descriptors, and the final destination name is opened relative to the pinned parent. Retargeting the visible parent pathname after it has been pinned therefore cannot redirect create/truncate/write activity into a foreign directory. Hosts without that component-anchored API retain the existing pathname-open compatibility fallback.

After a destination descriptor is obtained, the helper still requires a regular file with `st_nlink == 1` and only then calls descriptor-based `ftruncate()`. Therefore a raced special-file destination cannot be truncated or written as a repacked payload, while normal regular-file repacks retain their existing behavior.

The later output snapshot measurement still requires the visible destination pathname to identify the exact inode written by the repack. If the namespace changes after the parent was pinned, verification fails closed instead of treating the hidden pinned write as publishable evidence.

`O_CLOEXEC` prevents the short-lived repack descriptors from being inherited across exec. This change does not alter external-data layout, range selection, publication semantics, or any production deployment behavior.
