# SmolLM2 P0 manifest runtime boundary

The real browser P0 provenance contract treats runtime parameters and manifest values as untrusted runtime input. `validateSmolLm2P0RuntimeParameters()` first requires a non-array object before reading the pinned `modelId`, `kvHeads`, and `headSize` fields.

When the browser harness is launched with `artifactBudget=p0`, `runner-bootstrap.js` now parses the same `model`, `kvHeads`, and `headSize` values as the full runner and applies the pinned runtime-parameter validator before loading ONNX Runtime or importing `runner-v3.js`. This keeps deterministic P0 configuration mismatches ahead of external runtime/module loading. `absolute` mode is unchanged, and `runner-v3.js` retains the same P0 validation as defense in depth for direct/module-level use.

Mismatch and invalid-index diagnostics render malformed values without calling user-defined `toString` or `Symbol.toPrimitive` hooks. This keeps rejected asserted/deserialized inputs on the explicit P0 contract path rather than letting diagnostic string coercion replace the failure with an incidental JavaScript exception.

The pinned SmolLM2 source revision, graph/external-data digests, geometry, and browser-budget constants are unchanged. This is reliability hardening for Issue #636 / #167 and does not provide new real-model artifact-size, physical WebGPU memory, multi-browser relay/latency, or worker-loss evidence.
