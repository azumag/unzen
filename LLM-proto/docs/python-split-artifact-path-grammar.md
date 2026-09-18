# Python split artifact path grammar

`tools/verify_multi_segment_artifacts.py` validates graph `path` and external-data `location` spellings before `PurePosixPath`, `PureWindowsPath`, or filesystem resolution can normalize them.

Accepted generated artifact paths are non-empty relative identities separated only by forward slashes. The preflight rejects leading or trailing separators, redundant empty components such as `a//b`, explicit `.` components such as `a/./b`, `..`, backslashes, rooted or drive-qualified paths, colon-based drive/scheme aliases, Windows reserved/trailing-dot-space components, and ASCII control characters including DEL.

The raw-spelling checks run for every graph and external-data declaration before the first artifact payload is passed to `_measure_file()`. A malformed path in a later segment therefore cannot cause earlier large graph or external-data payloads to be hashed before rejection.

Ordinary nested paths such as `nested/graphs/segment0.onnx` and `nested/weights/segment0.onnx_data` remain valid. After raw grammar validation, the existing resolved-root containment, cross-segment path uniqueness, portable ASCII case-alias checks, descriptor-pinned hashing, byte accounting, digest verification, and browser-budget checks remain unchanged.

This keeps the stdlib-only Python preflight aligned with the generated-ONNX importer path grammar instead of accepting a spelling that Python path objects silently normalize but the runtime later refuses. It is host-side reliability/integrity hardening only and does not add physical WebGPU or multi-browser execution evidence.
