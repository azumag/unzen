# Endpoint embedding WebGPU prepared-file expectation snapshot

`tools/preflight_endpoint_embedding_webgpu_capture.mjs::verifyPreparedFileIdentity()` treats the expected byte length and SHA-256 as one operation-local identity snapshot.

Before any filesystem metadata lookup or streaming hash begins, `expected.bytes` and `expected.sha256` are each read exactly once into owned scalar values. Those captured values are validated and then reused for the pre-hash size check, post-hash digest comparison, and mismatch diagnostics. An exported direct caller therefore cannot make later accessor/proxy reads change the identity expectation after validation or during an expensive hash.

Prepared graph/payload files are now also hashed from one accepted open file descriptor rather than by reopening the pathname through a separate stream. The pre-open pathname must be a non-symlink regular file; the descriptor is opened read-only with `O_NOFOLLOW` where available and must match that pathname snapshot on device, inode, size, `mtime`, and `ctime` before any bytes are consumed. SHA-256 is then computed through a bounded 1 MiB buffer from that descriptor. After hashing, descriptor metadata and exact byte count must still match the accepted snapshot, and the pathname must still name the same non-symlink regular-file metadata snapshot before the digest is accepted. The descriptor is closed on success and every failure path. `atime` is intentionally excluded because reading can update it.

This closes the check/reopen race where a prepared pathname could be rebound after the initial metadata check so a different inode supplied the hashed bytes and then be rebound before the final pathname check. It also fails closed on observable same-inode metadata drift during hashing. This remains a metadata-based integrity guard rather than an adversarial filesystem snapshot primitive: content changes that expose no device/inode/size/mtime/ctime change, or changes after the final pathname validation, remain outside the guarantee.

The expected-byte/digest contract, returned report shape, diagnostic-only evidence level, and normal pinned-contract path are otherwise unchanged.

This is host-side preflight reliability hardening only. It is not new real-model, physical WebGPU, relay/latency, residency, deployment, credential, billing, or model-acquisition evidence for #167.
