# Endpoint embedding WebGPU persisted-evidence file snapshot

The captured endpoint embedding evidence validators are intentionally read-only and remain `diagnostic-only`. Persisted evidence is now read from one opened regular-file snapshot instead of by pathname alone.

Both `verify_endpoint_embedding_webgpu_runtime_evidence.mjs` and `verify_endpoint_embedding_webgpu_device_context.mjs` use the shared `read_stable_regular_utf8_file.mjs` helper. The helper:

- rejects a final symlink and non-regular file;
- opens the requested path with read-only/no-follow semantics where the platform exposes `O_NOFOLLOW`;
- binds the opened file descriptor to the pathname `(device,inode)` identity observed immediately before open;
- reads through a bounded chunk loop instead of an unbounded `readFileSync`, with a default maximum of 16 MiB for persisted UTF-8 evidence;
- rejects a file already above that limit before buffering it, and probes one byte beyond an exact-limit read so concurrent growth cannot make the verifier buffer without bound;
- verifies size/mtime/ctime and descriptor identity are unchanged across the read;
- verifies the requested pathname still resolves to the same regular file after the read;
- only then returns the UTF-8 bytes for JSON parsing and the existing captured-evidence validators.

This closes a local pathname-replacement gap in offline verification and bounds the memory consumed before JSON parsing. A verifier should not report success for bytes read from one inode while the reviewed evidence pathname has moved to another inode during the verification window, and a malformed or accidentally huge evidence pathname must not cause an unbounded read.

The 16 MiB ceiling is a verifier input-safety bound, not an artifact-size policy and not a production runtime decision. Current captured endpoint evidence is expected to be far smaller; callers of the shared helper can supply a smaller positive safe-integer byte limit for narrower contexts.

This is a filesystem snapshot/read-integrity check, not a signature or same-user adversary boundary. A process with sufficient local privileges can still modify files before or after the bounded verification window. Content/source/Chrome/WebGPU/tile/numerical validation remains the responsibility of the existing captured-evidence contract.

Typical verification remains:

```sh
node tools/verify_endpoint_embedding_webgpu_runtime_evidence.mjs \
  /tmp/endpoint-embedding-webgpu-runtime.json

node tools/verify_endpoint_embedding_webgpu_device_context.mjs \
  /tmp/endpoint-embedding-webgpu-runtime.json
```
