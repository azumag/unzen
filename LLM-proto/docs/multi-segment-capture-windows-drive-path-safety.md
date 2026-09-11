# Windows rooted and drive-qualified path safety

The #167 multi-segment producer and validation chain treats manifest, evidence, segment-artifact, and source external-data locations as portable paths relative to an explicit root. Windows drive-qualified and drive-rooted forms therefore are not valid relative identities, even when `PureWindowsPath(...).is_absolute()` is false.

For example, `C:payload.bin` is drive-qualified on Windows but `PureWindowsPath("C:payload.bin").is_absolute()` is false. Its meaning depends on per-drive current-directory state, so accepting it would make a supposedly root-relative identity process-state dependent.

A second edge case is `\\payload.bin`: `PureWindowsPath("\\payload.bin")` has an empty drive and `is_absolute()` is false, but its `root` is non-empty. On Windows it is rooted at the current drive rather than beneath the explicit artifact/source root. Portable-relative validation therefore must reject both non-empty `drive` and non-empty `root`.

All independent validation boundaries covered by #384 reject any path whose `PureWindowsPath(...).drive` is non-empty:

- `verify_multi_segment_capture_source.py`
- `audit_multi_segment_capture.py`
- `verify_multi_segment_capture_source_provenance.py`
- `verify_multi_segment_capture_bundle.py`
- `verify_multi_segment_artifact_snapshot.py`
- `verify_multi_segment_artifacts.py`
- `verify_multi_segment_onnx.py`

Issue #386 extended the drive-qualified contract to the split producer itself:

- `multi_segment_onnx.py`

Issue #388 additionally hardens the rooted-but-drive-less edge case. The split producer, `verify_multi_segment_artifacts.py`, `verify_multi_segment_capture_source_provenance.py`, and `verify_multi_segment_onnx.py` now reject relevant locations with either a non-empty Windows `drive` or `root`. The same `root` check still needs to be propagated through the remaining independent downstream validator/auditor boundaries before #388 is complete:

- `verify_multi_segment_capture_source.py`
- `audit_multi_segment_capture.py`
- `verify_multi_segment_capture_bundle.py`
- `verify_multi_segment_artifact_snapshot.py`

Existing absolute-path and `..` escape checks remain in place. Ordinary relative identities such as `model_q4.onnx_data` and `weights/chunk-0001.bin` remain accepted.

Regression coverage lives in `tools/tests/test_capture_source_windows_drive_paths.py` for the stdlib-only capture/provenance/artifact boundaries, `tools/tests/test_verify_multi_segment_onnx_windows_drive_paths.py` for the numerical verifier boundary, and `tools/tests/test_multi_segment_onnx_windows_drive_paths.py` for the split producer boundary. Rooted-path coverage now exists for the producer, artifact-integrity verifier, source-provenance verifier, and numerical verifier; the remaining downstream rooted-path cases stay tracked by #388.

This is path-validation hardening only: no artifact budget, split policy, runtime execution policy, source hashing mode, production deployment, credential, external billing, or physical-layout behavior changes.
