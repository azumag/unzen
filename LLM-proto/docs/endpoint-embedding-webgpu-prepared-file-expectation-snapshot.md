# Endpoint embedding WebGPU prepared-file expectation snapshot

`tools/preflight_endpoint_embedding_webgpu_capture.mjs::verifyPreparedFileIdentity()` treats the expected byte length and SHA-256 as one operation-local identity snapshot.

Before any filesystem metadata lookup or streaming hash begins, `expected.bytes` and `expected.sha256` are each read exactly once into owned scalar values. Those captured values are validated and then reused for the pre-hash size check, post-hash digest comparison, and mismatch diagnostics. An exported direct caller therefore cannot make later accessor/proxy reads change the identity expectation after validation or during an expensive hash.

The regular-file and symlink checks, before/after file identity comparison, streaming hash behavior, returned report shape, and normal pinned-contract path are unchanged.

This is host-side preflight reliability hardening only. It is not new real-model, physical WebGPU, relay/latency, residency, deployment, credential, billing, or model-acquisition evidence for #167.
