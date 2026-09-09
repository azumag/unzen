# Endpoint embedding WebGPU persisted-evidence file snapshot

The captured endpoint embedding evidence validators are intentionally read-only and remain `diagnostic-only`. Persisted evidence is now read from one opened regular-file snapshot instead of by pathname alone.

Both `verify_endpoint_embedding_webgpu_runtime_evidence.mjs` and `verify_endpoint_embedding_webgpu_device_context.mjs` use the shared `read_stable_regular_utf8_file.mjs` helper. The helper:

- rejects a final symlink and non-regular file;
- opens the requested path with read-only/no-follow semantics where the platform exposes `O_NOFOLLOW`;
- binds the opened file descriptor to the pathname `(device,inode)` identity observed immediately before open;
- verifies size/mtime/ctime and descriptor identity are unchanged across the read;
- verifies the requested pathname still resolves to the same regular file after the read;
- only then returns the UTF-8 bytes for JSON parsing and the existing captured-evidence validators.

This closes a local pathname-replacement gap in offline verification: a verifier should not report success for bytes read from one inode while the reviewed evidence pathname has moved to another inode during the verification window.

This is a filesystem snapshot/read-integrity check, not a signature or same-user adversary boundary. A process with sufficient local privileges can still modify files before or after the bounded verification window. Content/source/Chrome/WebGPU/tile/numerical validation remains the responsibility of the existing captured-evidence contract.

Typical verification remains:

```sh
node tools/verify_endpoint_embedding_webgpu_runtime_evidence.mjs \
  /tmp/endpoint-embedding-webgpu-runtime.json

node tools/verify_endpoint_embedding_webgpu_device_context.mjs \
  /tmp/endpoint-embedding-webgpu-runtime.json
```
