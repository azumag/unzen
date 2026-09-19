# Preferred endpoint payload pinning boundary

`tools/probe_llama_1b_endpoint_preferred_tile_ort_cpu.py` treats each materialized preferred endpoint payload as an untrusted filesystem path until it has pinned and verified a regular-file descriptor.

The pinning sequence is intentionally fail closed:

1. `lstat()` the requested payload path and require a regular file with the expected byte length;
2. open the path read-only with `O_NOFOLLOW`, `O_NONBLOCK`, and `O_CLOEXEC` when the host exposes those flags;
3. immediately `fstat()` the descriptor and require that it is still the same regular-file identity observed before `open()`;
4. hash the descriptor contents and require the pinned SHA-256;
5. re-check descriptor and path identity after hashing and again after diagnostic execution.

`O_NONBLOCK` is part of the trust boundary rather than a performance option. Without it, a regular file that is replaced by a FIFO or device between `lstat()` and `open()` can make the diagnostic block before the post-open `fstat()` can reject the replacement. The nonblocking open lets the helper reach that descriptor-type check and fail instead of hanging.

`O_CLOEXEC` prevents the diagnostic's pinned payload descriptors from being inherited by unrelated child processes. These flags do not weaken the existing SHA-256, symlink, identity, or mutation checks and do not change the endpoint layout or browser artifact contract.

This is host-side diagnostic hardening only. It is not new WebGPU, browser-cache, relay, or full-model numerical evidence for #167.
