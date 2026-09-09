# Endpoint embedding WebGPU device-context verification

Issue #223's complete embedding capture already records browser and WebGPU context in the runtime report (`userAgent`, `adapterInfo`, and `adapterLimits`) in addition to the captured Chrome/CDP environment. `tools/verify_endpoint_embedding_webgpu_device_context.mjs` adds a read-only verification layer for those fields without promoting the candidate architecture or changing runtime semantics.

Run it on a persisted `captured-browser-runtime` evidence file:

```bash
node tools/verify_endpoint_embedding_webgpu_device_context.mjs \
  /tmp/endpoint-embedding-webgpu-runtime.json
```

The verifier first reuses the existing captured-evidence validator, so pinned source identity, physical payloads, tile routing, graph digests, numerical equality, release timings, timestamp, and Chrome/CDP version checks still have to pass. It then requires the runtime `userAgent` to identify Chrome or HeadlessChrome with the same major version as the CDP browser, preserves `adapterInfo` as either `null` or a four-string WebGPU adapter descriptor, and requires the recorded `maxBufferSize`, `maxStorageBufferBindingSize`, and `maxComputeWorkgroupStorageSize` values to be positive safe integers.

This is evidence-integrity hardening only. Adapter strings may be empty or redacted by the browser, and the verifier does not interpret a particular vendor, architecture, or limit value as production approval. It does not select the 4-way physical / 8-way execution layout, change manifest/cache/loader/dispatcher contracts, prove memory reclamation, or establish decoder/KV/checkpoint full-model staged equivalence.
