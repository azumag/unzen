# Endpoint embedding WebGPU Chrome/host-probe identity snapshot

`tools/preflight_endpoint_embedding_webgpu_capture.mjs::validateChromeHostProbeIdentity()` treats the selected Chrome version and host-probe user agent as one operation-local identity snapshot.

The validator reads `chrome.version` and `hostProbe.userAgent` exactly once, validates the captured strings, and derives both Chrome major versions only from those owned scalar values. This prevents accessor-backed or proxied direct callers from changing the identity observed between syntax validation and the major-version comparison.

Successful validation still returns the original `hostProbe` object. The normal executable/loopback probe path, validation ordering before payload hashing, error taxonomy, and report schema are unchanged.

This is host-side preflight reliability hardening only. It is not new real-model, physical WebGPU, relay/latency, residency, deployment, credential, billing, or model-acquisition evidence for #167.
