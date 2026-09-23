# Pinned payload expectation preflight

`tools/probe_llama_1b_endpoint_preferred_tile_ort_cpu.py::_open_pinned_payload()` is the shared descriptor-pinning boundary used by multiple endpoint CPU and preparation diagnostics. Its caller-supplied expectations are validated before any filesystem metadata lookup or descriptor open.

The expected byte length must be a positive integer and must not be a boolean. The expected SHA-256 must be a string containing exactly 64 lowercase hexadecimal characters. Invalid expectations fail immediately and do not call `Path.lstat()` or `os.open()`.

After those argument checks, the existing payload trust boundary is unchanged: the requested path must be a non-symlink regular file of the pinned size, the final descriptor open uses the available no-follow/nonblocking/close-on-exec flags, the path and descriptor identities must match, the descriptor is hashed byte-for-byte, and both descriptor and pathname identities are checked again for mutation or replacement.

This is host-side fail-fast hardening only. It does not change pinned payload identities, endpoint layout selection, ONNX Runtime numerical semantics, browser/WebGPU evidence, deployment, credentials, billing, or model acquisition.
