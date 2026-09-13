# Generated ONNX import input ownership

`importGeneratedOnnxSplitManifest()` treats the generated split manifest as an untrusted runtime boundary, including accessor-backed objects and Proxy/array inputs.

The importer captures the root `segments` property once, copies its array entries into an owned snapshot, and only then parses segment records. This prevents a segment getter or parse-time side effect from changing later array membership while the import is iterating.

Each segment's `externalData` property is likewise captured once and its entries copied into an owned snapshot before path, byte-size, and digest validation. A caller-controlled getter cannot therefore present one external-data container to the array check and another container to parsing.

These container snapshots complement the single-read option contract: caller-owned containers determine the import input only at the explicit capture point, while existing schema, geometry, browser-budget, path-safety, and digest validation remain authoritative for the captured values.

This is runtime input-integrity hardening for the #167 artifact-import path. It is not real `Llama-3.2-1B-Instruct` q4 artifact materialization, physical WebGPU memory evidence, real multi-browser relay/latency evidence, or worker-loss/resume evidence, and it does not change the #158 production HOLD boundary.
