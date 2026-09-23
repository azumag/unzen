# Endpoint embedding WebGPU adapter-limit snapshot

`tools/verify_endpoint_embedding_webgpu_tile_device_budget.mjs::evaluateEndpointEmbeddingWebGpuTileDeviceBudget()` treats the two required WebGPU adapter limits as one operation-local input snapshot.

`maxBufferSize` and `maxStorageBufferBindingSize` are each read exactly once from the caller-supplied object, validated as positive safe integers, and copied into an owned plain object before either the execution-tile gate or the physical-artifact single-binding diagnostic is computed. Both diagnostics therefore use the same captured values even when the exported evaluator is invoked with accessor-backed or proxied objects.

The persisted-evidence path is unchanged: the stable JSON file reader runs first, the primary captured runtime-evidence validator runs next, and the device-budget evaluator runs only after that validation succeeds. Report schema, pinned tile/artifact constants, pass/fail semantics, and the diagnostic-only evidence boundary are unchanged.

This is host-side diagnostic reliability hardening only. It is not new real-model, physical WebGPU, relay/latency, residency, deployment, credential, billing, or model-acquisition evidence for #167.
