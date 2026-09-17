# Endpoint WebGPU artifact read boundary

The endpoint-layout WebGPU harnesses reuse the same bounded response-stream reader as the main split-browser harness for graph and external-data artifacts.

Affected diagnostic harnesses:

- `browser-harness/endpoint-tile-webgpu/runner.js`
- `browser-harness/endpoint-five-way-tile-webgpu/runner.js`
- `browser-harness/endpoint-embedding-tiled-webgpu/runner.js`
- `browser-harness/endpoint-poststage-tiled-webgpu/runner.js`
- `browser-harness/endpoint-embedding-eight-physical-webgpu/runner.js`

Each local `loadVerified()` supplies both the manifest-declared `expectedBytes` and `BROWSER_SEGMENT_ABSOLUTE_MAX_BYTES` to `readResponseBytesBounded()`. The reader therefore rejects an oversized `Content-Length` before consuming the body when that metadata is available, enforces the byte ceiling while streaming when it is not, and verifies the exact declared size before the harness computes the existing SHA-256 digest.

These harnesses must not fall back to `Response.arrayBuffer()` for model artifacts: several probes intentionally exercise payloads around the preferred browser artifact budget, so allocating an unbounded full response before checking its declared size defeats the runtime memory boundary the probes are meant to exercise.

This change is reliability and host-memory hardening only. It does not change manifest semantics, evidence level, numerical tolerance, WebGPU execution behavior, architecture-selection status, or the evidence credited to #167.
