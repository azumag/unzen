# Generated ONNX import option ownership

`importGeneratedOnnxSplitManifest()` treats `GeneratedOnnxManifestImportOptions` as a runtime trust boundary.

The import performs asynchronous SHA-256 work while it converts the generated split manifest into the runtime `SegmentedModelManifest`. Caller-owned options therefore must not remain authoritative after the initial validation pass: a caller can still hold and mutate the original object while bundle and manifest digests are being awaited.

The importer captures every caller-owned root option field exactly once, then validates and snapshots only those captured values before reading the generated artifact manifest. Mutable arrays are copied element-by-element from a single captured container, and the nested `runtimeRequirements` fields (including `supportedQuantization`) are likewise captured once before validation and freezing. Accessor-backed objects or Proxies therefore cannot return one value for validation and a different value while the owned snapshot is assembled.

The stable snapshot owns copies of mutable arrays and the nested `runtimeRequirements` object. All later artifact construction, digesting, source-policy validation, and manifest validation read from that snapshot rather than from the caller-owned object.

This guarantees both synchronous validation/snapshot consistency and asynchronous mutation isolation: caller-controlled getters cannot drift model identity or runtime policy during snapshot construction, and post-validation mutation cannot change model identity, source namespace, memory basis, runtime compatibility, runtime requirements, or other option-derived manifest fields while the import is in flight.

This contract is integrity hardening for the #167 artifact-import path only. It does not constitute real `Llama-3.2-1B-Instruct` q4 artifact materialization, physical WebGPU memory evidence, real multi-browser relay/latency evidence, or worker-loss/resume evidence, and it does not change the #158 production HOLD boundary.
