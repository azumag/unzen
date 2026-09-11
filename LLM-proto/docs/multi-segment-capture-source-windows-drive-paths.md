# Capture source paths: Windows drive-qualified names

Issue: #382  
Parent: #167

The post-publication capture/source verification chain treats source external-data locations as portable paths relative to the full-model directory. A Windows drive-qualified path is therefore never a valid source-relative identity, even when Windows considers it drive-relative rather than absolute.

Examples rejected by the verifier include:

- `C:payload.bin`
- `D:nested\payload.bin`
- ordinary absolute Windows paths such as `C:\models\payload.bin`

The first two forms are important because `PureWindowsPath(...).is_absolute()` is false for drive-relative names. Their meaning depends on the current directory associated with that drive, so accepting them would make provenance interpretation depend on process-local Windows state rather than solely on the capture metadata and supplied source root.

`verify_multi_segment_capture_source.py` therefore rejects any source-relative path whose `PureWindowsPath(...).drive` is non-empty, in addition to the existing absolute-path and parent-traversal checks. `audit_multi_segment_capture.py` applies the same rule when it independently normalizes source external-data metadata from the source verifier report.

Normal portable relative paths such as `model.onnx_data` and `nested/payload.bin` remain valid.

This is diagnostic-only validation hardening. It does not change artifact budgets, model/runtime behavior, the selected physical layout, WebGPU execution, production deployment, or the evidence level of an existing capture.
