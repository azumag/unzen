# Windows drive-qualified path safety

The #167 multi-segment validation chain treats manifest, evidence, segment-artifact, and source external-data locations as portable paths relative to an explicit root. Windows drive-qualified forms therefore are not valid relative identities, even when they are drive-relative rather than syntactically absolute.

For example, `C:payload.bin` is drive-qualified on Windows but `PureWindowsPath("C:payload.bin").is_absolute()` is false. Its meaning depends on per-drive current-directory state, so accepting it would make a supposedly root-relative identity process-state dependent.

All independent validation boundaries covered by #384 now reject any path whose `PureWindowsPath(...).drive` is non-empty:

- `verify_multi_segment_capture_source.py`
- `audit_multi_segment_capture.py`
- `verify_multi_segment_capture_source_provenance.py`
- `verify_multi_segment_capture_bundle.py`
- `verify_multi_segment_artifact_snapshot.py`
- `verify_multi_segment_artifacts.py`
- `verify_multi_segment_onnx.py`

Existing absolute-path and `..` escape checks remain in place. Ordinary relative identities such as `model_q4.onnx_data` and `weights/chunk-0001.bin` remain accepted.

Regression coverage lives in `tools/tests/test_capture_source_windows_drive_paths.py` for the stdlib-only capture/provenance/artifact boundaries and `tools/tests/test_verify_multi_segment_onnx_windows_drive_paths.py` for the numerical verifier boundary.

This is validation hardening only: no artifact budget, runtime execution policy, source hashing mode, production deployment, credential, external billing, or physical-layout behavior changes.
