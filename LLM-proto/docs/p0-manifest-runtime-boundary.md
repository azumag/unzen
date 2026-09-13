# SmolLM2 P0 manifest runtime boundary

The real browser P0 provenance contract treats runtime parameters and manifest values as untrusted runtime input. `validateSmolLm2P0RuntimeParameters()` first requires a non-array object before reading the pinned `modelId`, `kvHeads`, and `headSize` fields.

Mismatch and invalid-index diagnostics render malformed values without calling user-defined `toString` or `Symbol.toPrimitive` hooks. This keeps rejected asserted/deserialized inputs on the explicit P0 contract path rather than letting diagnostic string coercion replace the failure with an incidental JavaScript exception.

The pinned SmolLM2 source revision, graph/external-data digests, geometry, and browser-budget constants are unchanged. This is reliability hardening for Issue #636 / #167 and does not provide new real-model artifact-size, physical WebGPU memory, multi-browser relay/latency, or worker-loss evidence.
