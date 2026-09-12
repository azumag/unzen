# Generated ONNX import path safety

`importGeneratedOnnxSplitManifest()` treats generated graph and external-data paths as untrusted input and validates them before constructing runtime artifact locators.

Accepted paths must be relative, forward-slash separated artifact identities. Absolute/rooted paths, backslashes, URI/drive separators, control characters, empty components, `.` and `..` are rejected.

The runtime import boundary also mirrors the Windows alias rules used by the Python split producer and independent verifiers. Every path component is rejected when it ends in `.` or a space, has a reserved DOS device stem (`CON`, `PRN`, `AUX`, `NUL`), or matches `COM`/`LPT` ports 1-9 including the Windows-recognized superscript variants `¹`, `²`, and `³`. Device stems remain reserved when an extension is present, so names such as `CON.onnx` and `COM1.bin` are invalid.

This keeps artifact identity platform-independent between POSIX producers/verifiers and Windows consumers. Ordinary relative paths such as `graphs/segment0.onnx` and `weights/chunk-0001.bin` remain valid.

This contract is path-identity hardening only. It does not replace content digest verification, browser artifact byte-budget enforcement, or transport/runtime trust checks.