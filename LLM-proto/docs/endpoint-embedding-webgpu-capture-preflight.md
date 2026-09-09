# Endpoint embedding WebGPU capture preflight

Status: **diagnostic-only / #223 S0 support**. This preflight does not select the 4-way physical / 8-way execution candidate and does not change production manifest, cache, loader, runtime, residency, dispatcher, or artifact-policy behavior.

## Purpose

The complete endpoint embedding browser harness is intentionally strict and processes four prepared physical payloads totaling about 1 GiB before it can produce real browser/WebGPU evidence. `tools/preflight_endpoint_embedding_webgpu_capture.mjs` provides a fail-fast check for the prepared bundle, Chrome executable, and basic Chrome/WebGPU host capability before spending time hashing the full bundle or running ORT Web.

The preflight first validates the exact pinned preparation manifest through the same `validateEndpointEmbeddingWebGpuManifest()` contract used by the harness and executes the selected Chrome binary with `--version`, requiring a four-part browser version. It then launches a short-lived isolated headless Chrome against a loopback secure context and requires `navigator.gpu`, a WebGPU adapter, and successful `adapter.requestDevice()`. The probe records adapter/device limits, destroys the probe device, and exits before the large prepared payload files are streamed. A host with no usable WebGPU device therefore fails before roughly 1 GiB of SHA-256 work.

Only after the lightweight host probe passes does the preflight stream every required ONNX graph and physical payload through SHA-256 verification. It rejects symlinked artifacts, non-regular files, byte-length drift, digest drift, or a file whose identity changes while it is being hashed. The payloads are streamed instead of being read into one large Node.js buffer.

The capture helper runs this same preflight automatically after its cheap local port-availability checks and before it reserves the evidence output path, creates the capture Chrome profile, starts the harness, or launches the ORT Web browser run. Running the standalone command remains useful when an operator wants a bounded readiness report without starting the full capture, but it is no longer a correctness prerequisite that can be accidentally skipped.

## Run

Prepare the bundle as documented in `endpoint-embedding-tiled-webgpu.md`. To inspect readiness separately, run:

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

A passing JSON summary reports `decisionStatus=diagnostic-only`, the pinned manifest identity, the Chrome version, the lightweight `hostProbe` result, the six verified prepared files (two graph variants plus four physical payloads), and the total verified byte count. The host probe is intentionally small: it uses the same headless/WebGPU flags as the capture, binds only to `127.0.0.1` on an ephemeral port, uses a temporary Chrome profile, creates one default WebGPU device, records bounded capability context, destroys the device, and cleans up the profile/server.

The actual capture can be invoked directly; it repeats the same mandatory preflight automatically before the ORT Web browser process is launched:

```bash
node tools/capture_endpoint_embedding_webgpu_runtime.mjs \
  /tmp/unzen-endpoint-embedding-webgpu-data \
  /tmp/endpoint-embedding-webgpu-runtime.json
```

The standalone preflight remains optional operator feedback, while the capture helper itself enforces the gate at the execution boundary.

## What a pass means

A pass means the local prepared input bundle still matches the exact #223 diagnostic contract, the chosen Chrome executable reports a normal four-part version, and a short-lived Chrome page on a loopback secure context can obtain a WebGPU adapter, create a default device, expose sane positive limits, and destroy that device. This closes the previous readiness gap where a host without usable WebGPU could spend time hashing the full prepared payload set before failing during the browser run.

It still does **not** prove that ONNX Runtime Web assigns every model node to WebGPU, that the complete embedding ORT run succeeds, that `InferenceSession.release()` reclaims GPU memory immediately, or that decoder/KV/checkpoint full-model staged equivalence is established. Only the captured runtime evidence from the browser helper can close the narrow embedding-side browser execution check.
