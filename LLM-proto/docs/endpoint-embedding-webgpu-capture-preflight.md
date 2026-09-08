# Endpoint embedding WebGPU capture preflight

Status: **diagnostic-only / #223 S0 support**. This preflight does not select the 4-way physical / 8-way execution candidate and does not change production manifest, cache, loader, runtime, residency, dispatcher, or artifact-policy behavior.

## Purpose

The complete endpoint embedding browser harness is intentionally strict and processes four prepared physical payloads totaling about 1 GiB before it can produce real browser/WebGPU evidence. `tools/preflight_endpoint_embedding_webgpu_capture.mjs` provides a fail-fast check for the prepared bundle and Chrome executable before spending time on the browser run.

It validates the exact pinned preparation manifest through the same `validateEndpointEmbeddingWebGpuManifest()` contract used by the harness, then streams every required ONNX graph and physical payload through SHA-256 verification. It rejects symlinked artifacts, non-regular files, byte-length drift, digest drift, or a file whose identity changes while it is being hashed. The payloads are streamed instead of being read into one large Node.js buffer.

The preflight also executes the selected Chrome binary with `--version` and requires a four-part browser version. This catches a missing or obviously incompatible browser command before the capture helper is started.

## Run

Prepare the bundle as documented in `endpoint-embedding-tiled-webgpu.md`, then run:

```bash
cd LLM-proto
node tools/preflight_endpoint_embedding_webgpu_capture.mjs \
  /tmp/unzen-endpoint-embedding-webgpu-data
```

On macOS the default browser is:

```text
/Applications/Google Chrome.app/Contents/MacOS/Google Chrome
```

Elsewhere, either set `CHROME_BINARY` or pass the browser command/path explicitly:

```bash
node tools/preflight_endpoint_embedding_webgpu_capture.mjs \
  /tmp/unzen-endpoint-embedding-webgpu-data \
  /path/to/google-chrome
```

A passing JSON summary reports `decisionStatus=diagnostic-only`, the pinned manifest identity, the Chrome version, the six verified prepared files (two graph variants plus four physical payloads), and the total verified byte count.

After a pass, run the actual capture helper:

```bash
node tools/capture_endpoint_embedding_webgpu_runtime.mjs \
  /tmp/unzen-endpoint-embedding-webgpu-data \
  /tmp/endpoint-embedding-webgpu-runtime.json
```

## What a pass means

A pass means the local prepared input bundle still matches the exact #223 diagnostic contract and that the chosen Chrome executable can report a normal four-part version. It is a readiness check only.

It does **not** prove that WebGPU is available, that ONNX Runtime Web assigns every node to WebGPU, that the browser run succeeds, that `InferenceSession.release()` reclaims GPU memory immediately, or that decoder/KV/checkpoint full-model staged equivalence is established. Only the captured runtime evidence from the browser helper can close the narrow embedding-side browser execution check.
