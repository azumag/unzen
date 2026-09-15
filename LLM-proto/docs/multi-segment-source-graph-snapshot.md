# Multi-segment source graph snapshot boundary

Issue #854 binds the budgeted multi-segment generator's source ONNX parsing and manifest identity to one descriptor-captured graph snapshot.

Before this change, `prepare_budgeted_multi_split()` opened the source graph once through `onnx.load_model(path, load_external_data=False)` and reopened the pathname later through `sha256_file(path)` when writing `sourceModel.sha256`. A pathname replacement between those observations could therefore make the manifest identify graph bytes different from the graph that was actually planned and split.

The generator now captures the source graph once before planning. The snapshot reader resolves the requested path, requires the resolved target to be a regular file, opens it read-only with nonblocking/no-follow flags where supported, and caps the graph at 64 MiB. It rejects path-to-open identity changes, read-time mutation or growth, resolved-target replacement, and requested-path retargeting. Stable symlinks remain accepted so existing source-path semantics are preserved.

The exact captured bytes are passed to `onnx.load_model()` through `BytesIO` with external data disabled. `sourceModel.sha256` is computed from those same bytes. The generator does not reopen the source graph to derive its manifest digest.

This boundary covers the ONNX graph file only. External-data files continue to use the existing range validation, hashing, and repacking paths, and their relative locations continue to be interpreted from the caller-supplied source model pathname. Generated segment validation and browser artifact budget enforcement are unchanged.

This is host-side generator integrity hardening. It does not add real Llama-3.2-1B q4 artifact evidence, physical WebGPU evidence, multi-browser relay/latency measurements, or worker-loss/resume evidence for #167, and it does not change the #158 production HOLD.
