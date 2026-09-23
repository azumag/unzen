# Endpoint embedding WebGPU host-probe limit snapshot

`tools/probe_endpoint_embedding_webgpu_host.mjs::validateEndpointEmbeddingWebGpuHostProbeResult()` treats the reported adapter and device limits as operation-local snapshots.

The validator reads the caller-supplied `adapterLimits` and `deviceLimits` objects once each. It then reads each required limit field exactly once, validates it as a positive safe integer, and copies the values into owned plain objects. The `deviceLimits <= adapterLimits` comparison is performed only against those owned snapshots, so an exported direct caller cannot make the comparison observe different values by using accessor-backed or proxied limit objects.

The validator still returns the original result object on success. The loopback browser-probe protocol, report schema, WebGPU flags, runtime behavior for ordinary JSON results, and existing validation errors are otherwise unchanged.

This is host-side diagnostic reliability hardening only. It is not new real-model, physical WebGPU, relay/latency, residency, deployment, credential, billing, or model-acquisition evidence for #167.
