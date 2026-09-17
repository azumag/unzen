# Endpoint WebGPU artifact read boundary

The endpoint-layout WebGPU harnesses reuse the same bounded response-stream reader as the main split-browser harness for graph and external-data artifacts.

Affected diagnostic harnesses:

- `browser-harness/endpoint-tile-webgpu/runner.js`
- `browser-harness/endpoint-five-way-tile-webgpu/runner.js`
- `browser-harness/endpoint-embedding-tiled-webgpu/runner.js`
- `browser-harness/endpoint-poststage-tiled-webgpu/runner.js`
- `browser-harness/endpoint-embedding-eight-physical-webgpu/runner.js`

Each local `loadVerified()` supplies both the manifest-declared `expectedBytes` and `BROWSER_SEGMENT_ABSOLUTE_MAX_BYTES` to `readResponseBytesBounded()`. The reader therefore rejects an oversized `Content-Length` before consuming the body when that metadata is available, enforces the byte ceiling while streaming when it is not, and verifies the exact declared size before the harness computes the existing SHA-256 digest.

The endpoint diagnostic servers expose the sibling `browser-harness/webgpu-2b-split/` directory only through the explicit `/webgpu-2b-split/` URL prefix. Browser module imports from the root-served `runner.js` therefore resolve the shared reader and its relative dependencies without broadening the ordinary endpoint static root. Shared-module paths continue to pass through the same root-containment check as other static files.

All five servers share `webgpu-2b-split/server-safe-path.mjs` for static-path containment. The helper derives lexical containment with `node:path.relative()` and `isAbsolute()` instead of comparing against a hard-coded `/` suffix, so valid nested files remain inside the selected root under both POSIX and Windows separator semantics. Parent traversal is normalized back under the selected static root, while drive-qualified/absolute relative results are rejected.

Before a file is streamed, the shared helper resolves both the selected serving root and the requested existing file to canonical filesystem paths, then repeats the containment check on those canonical paths. A symlinked file or intermediate directory whose target leaves `ROOT`, `DATA_DIR`, the shared `webgpu-2b-split` root, or the selected physical graph directory therefore fails closed before response headers or file bytes are sent. Symlinks that resolve to a file still inside the selected root remain valid.

The server then opens the canonical path before committing response headers, validates the opened descriptor as a regular file, and creates the response stream from that already-open `FileHandle`. A pathname replacement after this point cannot redirect the current response to a different inode. Every server attaches a stream `error` listener before piping and destroys the HTTP response on an asynchronous read failure, so a disappearing or unreadable artifact does not become an unhandled stream error that terminates the diagnostic process. Validation or stream-construction failures close the opened handle before propagating.

This remains a local diagnostic-server boundary, not a claim of hostile concurrent filesystem mutation isolation. There is still a race between canonical-path resolution and opening that canonical path because Node does not provide the dirfd/openat-style component walk used by the host-side capture verifier; an attacker able to replace canonical ancestors during that interval remains outside this guarantee. Once the file descriptor has been opened, however, subsequent pathname replacement does not alter the bytes read by that response.

CI exercises the shared route through the real Node diagnostic servers for all five harnesses. The integration contract boots each `serve.mjs` with an isolated temporary data directory, fetches the root-served `runner.js`, then follows the browser-visible `/webgpu-2b-split/` paths for `artifact-cache.js` and its direct local dependencies. A separate path-contract test evaluates the shared lexical containment helper with both `node:path.posix` and `node:path.win32`, uses real temporary directories to verify that an intermediate symlink cannot escape the selected root, and verifies descriptor binding by replacing a pathname after the file has been opened.

These harnesses must not fall back to `Response.arrayBuffer()` for model artifacts: several probes intentionally exercise payloads around the preferred browser artifact budget, so allocating an unbounded full response before checking its declared size defeats the runtime memory boundary the probes are meant to exercise.

This change is reliability and host-memory hardening only. It does not change manifest semantics, evidence level, numerical tolerance, WebGPU execution behavior, architecture-selection status, or the evidence credited to #167.
