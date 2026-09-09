# Endpoint embedding WebGPU capture preflight

Status: **diagnostic-only / #223 S0 support**. This preflight does not select the 4-way physical / 8-way execution candidate and does not change production manifest, cache, loader, runtime, residency, dispatcher, or artifact-policy behavior.

## Purpose

The complete endpoint embedding browser harness is intentionally strict and processes four prepared physical payloads totaling about 1 GiB before it can produce real browser/WebGPU evidence. `tools/preflight_endpoint_embedding_webgpu_capture.mjs` provides a fail-fast check for the prepared bundle, Chrome executable, and basic Chrome/WebGPU host capability before spending time hashing the full bundle or running ORT Web.

The preflight first validates the exact pinned preparation manifest through the same `validateEndpointEmbeddingWebGpuManifest()` contract used by the harness and executes the selected Chrome binary with `--version`. The version output must identify a supported Chrome-family product (`Google Chrome`, `Google Chrome for Testing`, or `Chromium`) and contain a four-part version; an unrelated browser or wrapper output is rejected even if it happens to contain the same numeric version. It then launches a short-lived isolated headless Chrome against a loopback secure context and requires `navigator.gpu`, a WebGPU adapter, and successful `adapter.requestDevice()`. The probe records adapter/device limits, destroys the probe device, and exits before the large prepared payload files are streamed. A host with no usable WebGPU device therefore fails before roughly 1 GiB of SHA-256 work.

Before payload hashing starts, the preflight also binds the host probe back to the selected Chrome executable identity: the Chrome/HeadlessChrome major reported by the probe page's user agent must equal the major extracted from the executable's accepted four-part `--version` output. This deliberately compares only the major because modern Chrome user-agent reduction commonly exposes `major.0.0.0` rather than the executable's complete build version. A wrapper or launch path that reports one Chrome version for `--version` but starts a different Chrome major for the WebGPU probe therefore fails before the expensive bundle verification.

The loopback host probe also binds its HTML route and result POST route to one random 256-bit per-run challenge. Requests to the old generic `/` and `/result` routes are not accepted. This avoids accidental cross-talk between concurrent/stale probes and prevents an unrelated loopback request from being accepted as the current probe result without knowing the per-run route. The challenge is visible to the launched browser and is not treated as a security boundary against a malicious same-user process with local inspection privileges.

Only after the lightweight host probe and Chrome-identity binding pass does the preflight stream every required ONNX graph and physical payload through SHA-256 verification. It rejects symlinked artifacts, non-regular files, byte-length drift, digest drift, or a file whose identity changes while it is being hashed. The payloads are streamed instead of being read into one large Node.js buffer.

The capture helper runs this same preflight automatically after its cheap local port-availability checks and before it reserves the evidence output path, creates the capture Chrome profile, starts the harness, or launches the ORT Web browser run. It carries the preflight's exact four-part Chrome identity into the real capture launch. As soon as the live DevTools `/json/version` endpoint becomes available, the helper requires the live `Browser` value to identify `Chrome` or `HeadlessChrome`, its four-part version to match the preflight version exactly, and the live DevTools `User-Agent` to report the same Chrome major **before navigating the ORT Web harness**. A wrapper, path replacement, product-identity substitution, or launch-mode drift between preflight and the real capture therefore fails before model execution. The final evidence records the preflight Chrome version snapshot together with the live CDP `Browser` and `User-Agent` snapshots rather than re-running `--version` after inference, so the evidence is bound to the executable identity that was actually gated and matched to the running CDP process.

Persisted `captured-browser-runtime` evidence is revalidated with the same product-identity requirements: `captureEnvironment.chromeVersion` must retain a supported Chrome-family executable identity, `captureEnvironment.cdpBrowser` must retain a Chrome/HeadlessChrome four-part identity, and `captureEnvironment.cdpUserAgent` must exactly equal the runtime report's `userAgent`. This last equality binds the page-reported runtime environment back to the live DevTools version endpoint used before navigation; preserving only a matching Chrome major is no longer enough.

Running the standalone command remains useful when an operator wants a bounded readiness report without starting the full capture, but it is no longer a correctness prerequisite that can be accidentally skipped.

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

A passing JSON summary reports `decisionStatus=diagnostic-only`, the pinned manifest identity, the Chrome version, the lightweight `hostProbe` result, the six verified prepared files (two graph variants plus four physical payloads), and the total verified byte count. The host probe is intentionally small: it uses the same headless/WebGPU flags as the capture, binds only to `127.0.0.1` on an ephemeral port, generates challenge-bound per-run probe/result routes, uses a temporary Chrome profile, creates one default WebGPU device, records bounded capability context, destroys the device, and cleans up the profile/server. Its Chrome major is checked against the selected executable before any prepared graph or payload is hashed.

The actual capture can be invoked directly; it repeats the same mandatory preflight automatically before the ORT Web browser process is launched:

```bash
node tools/capture_endpoint_embedding_webgpu_runtime.mjs \
  /tmp/unzen-endpoint-embedding-webgpu-data \
  /tmp/endpoint-embedding-webgpu-runtime.json
```

After the real Chrome process starts, the capture additionally checks the exact preflight/CDP four-part version match, the CDP Chrome/HeadlessChrome product identity, and the CDP `User-Agent` major before loading the harness. After the browser report is collected, the persisted capture requires that report's `userAgent` to exactly match the pre-navigation CDP `User-Agent`. The standalone preflight remains optional operator feedback, while the capture helper itself enforces both the readiness gate and the live-browser identity gate at the execution boundary.

## What a pass means

A pass means the local prepared input bundle still matches the exact #223 diagnostic contract, the chosen executable reports a supported Google Chrome/Chrome-for-Testing/Chromium identity with a four-part version, the lightweight WebGPU probe ran under the same Chrome major, the real capture process identifies itself as Chrome/HeadlessChrome and reports the same exact four-part version through CDP before ORT execution begins, the runtime page reports exactly the same user agent captured from that live CDP version endpoint, and a short-lived Chrome page on a challenge-bound loopback secure context can obtain a WebGPU adapter, create a default device, expose sane positive limits, and destroy that device. This closes the previous readiness gap where a host without usable WebGPU—or a version-reporting wrapper that launches a different or misidentified browser—could spend time hashing or executing against the full prepared payload set before the mismatch was discovered, while also preventing stale/concurrent probe traffic from satisfying the current run's result route accidentally.

It still does **not** prove that ONNX Runtime Web assigns every model node to WebGPU, that the complete embedding ORT run succeeds, that `InferenceSession.release()` reclaims GPU memory immediately, or that decoder/KV/checkpoint full-model staged equivalence is established. Only the captured runtime evidence from the browser helper can close the narrow embedding-side browser execution check.