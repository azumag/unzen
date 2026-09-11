# Windows drive-qualified source path safety

The post-publication #167 source provenance chain treats every external-data `location` as a portable path relative to the source-model directory. Windows drive-qualified forms therefore are not valid provenance identities, even when they are drive-relative rather than syntactically absolute.

For example, `C:payload.bin` is drive-qualified on Windows but `PureWindowsPath("C:payload.bin").is_absolute()` is false. Its meaning depends on per-drive current-directory state, so accepting it would make a supposedly source-relative identity process-state dependent.

`verify_multi_segment_capture_source.py` now rejects any external-data path whose `PureWindowsPath(...).drive` is non-empty. The independent external-data metadata validation in `audit_multi_segment_capture.py` applies the same fail-closed rule. Existing absolute-path and `..` escape checks remain in place.

Ordinary relative identities such as `model_q4.onnx_data` and `weights/chunk-0001.bin` remain accepted. This is validation hardening only: no artifact budget, runtime execution policy, source hashing mode, production deployment, credential, or physical-layout behavior changes.

Regression coverage lives in `tools/tests/test_capture_source_windows_drive_paths.py` and checks both the source verifier and complete-audit metadata boundary.
