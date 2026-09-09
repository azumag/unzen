# Endpoint embedding WebGPU device-context verification

Issue #223's complete embedding capture records browser and WebGPU context in the runtime report (`userAgent`, `adapterInfo`, and `adapterLimits`) in addition to the captured Chrome/CDP environment. The primary `captured-browser-runtime` validator now requires these fields before a capture can be promoted or persisted, so the normal capture path and the existing offline evidence verifier both fail closed when device context is missing or malformed.

Run the focused read-only verifier on a persisted evidence file when you want a bounded device-context summary:

```bash
node tools/verify_endpoint_embedding_webgpu_device_context.mjs \
  /tmp/endpoint-embedding-webgpu-runtime.json
```

The shared validation contract requires the runtime `userAgent` to identify Chrome or HeadlessChrome with the same major version as the captured CDP browser, preserves `adapterInfo` as either `null` or a four-string WebGPU adapter descriptor, and requires `maxBufferSize`, `maxStorageBufferBindingSize`, and `maxComputeWorkgroupStorageSize` to be positive safe integers. The primary captured-evidence validator still requires pinned source identity, physical payloads, tile routing, graph digests, byte-exact numerical equality, release timings, canonical capture timestamp, and exact Chrome/CDP full-version agreement before applying the device-context checks.

`tools/verify_endpoint_embedding_webgpu_device_context.mjs` reuses that same primary validator rather than maintaining a second device-context contract. The general `tools/verify_endpoint_embedding_webgpu_runtime_evidence.mjs` verifier also inherits the same requirements because it already calls the primary validator.

This remains evidence-integrity hardening only. Adapter strings may be empty or redacted by the browser, and no vendor, architecture, or adapter-limit threshold is interpreted as production approval. `decisionStatus` remains `diagnostic-only`; this does not select the 4-way physical / 8-way execution layout, change manifest/cache/loader/dispatcher contracts, prove memory reclamation, or establish decoder/KV/checkpoint full-model staged equivalence.
