# Endpoint embedding WebGPU preflight manifest snapshot

`tools/preflight_endpoint_embedding_webgpu_capture.mjs` reads `manifest.json` through the repository's shared `readStableRegularUtf8File()` boundary before JSON parsing or schema validation.

That boundary keeps the manifest read on one opened regular-file descriptor, rejects a final symlink, verifies the path and descriptor identify the same file, detects mutation or path retargeting across the read, decodes UTF-8 strictly, and applies the shared 16 MiB maximum. The capture preflight therefore no longer performs an unbounded path-based `readFileSync()` between two independent path metadata checks.

The existing ordering is preserved: the stable manifest snapshot is parsed and validated by `validateEndpointEmbeddingWebGpuManifest()` before Chrome is launched and before prepared graph or payload hashing begins. The shared default ceiling is reused rather than defining a new manifest-size policy.

This is host-side preflight reliability hardening only. It is not new real-model, physical WebGPU, relay/latency, residency, deployment, credential, billing, or model-acquisition evidence for #167.
