# Generated ONNX import path and numeric safety

`importGeneratedOnnxSplitManifest()` treats generated graph/external-data paths and segment geometry as untrusted input and validates them before constructing runtime artifacts.

## Path identity

Accepted paths must be relative, forward-slash separated artifact identities. Absolute/rooted paths, backslashes, URI/drive separators, control characters, empty components, `.` and `..` are rejected.

The runtime import boundary also mirrors the Windows alias rules used by the Python split producer and independent verifiers. Every path component is rejected when it ends in `.` or a space, has a reserved DOS device stem (`CON`, `PRN`, `AUX`, `NUL`), or matches `COM`/`LPT` ports 1-9 including the Windows-recognized superscript variants `¹`, `²`, and `³`. Device stems remain reserved when an extension is present, so names such as `CON.onnx` and `COM1.bin` are invalid.

This keeps artifact identity platform-independent between POSIX producers/verifiers and Windows consumers. Ordinary relative paths such as `graphs/segment0.onnx` and `weights/chunk-0001.bin` remain valid.

## Segment geometry numeric domain

Generated `segment.index`, `startLayer`, and `endLayer` values must be non-negative JavaScript safe integers. In particular, values greater than `Number.MAX_SAFE_INTEGER` are rejected before the Python half-open `[startLayer, endLayer)` span is converted into the runtime inclusive `layerStart` / `layerEnd` representation.

`Number.isInteger()` alone is not sufficient for this boundary: JavaScript can represent some integral-looking values above the safe-integer limit while losing adjacent-integer identity. Arithmetic such as `endLayer - 1` or later adjacency checks could therefore collapse distinct layer numbers. The importer fails closed before performing that conversion.

Normal generated layer counts are unaffected by this guard.

These contracts are import-boundary hardening only. They do not replace content digest verification, browser artifact byte-budget enforcement, or transport/runtime trust checks, and they do not constitute real WebGPU or multi-browser execution evidence.
