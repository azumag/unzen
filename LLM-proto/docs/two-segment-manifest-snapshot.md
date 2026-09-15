# Two-segment verification manifest snapshot

`tools/verify_split_onnx.py` uses `split-manifest.json` as control input for the same-machine numerical correctness gate. Boundary tensor names and the logits output determine how the full model and the two generated ONNX segments are executed, so those routing values must come from one stable filesystem object.

Before any ONNX Runtime session is created, the verifier now opens the manifest as a non-symlink regular file, binds the pathname metadata to the opened descriptor, reads all bytes from that descriptor, verifies that descriptor metadata did not change during the read, and then rechecks that the pathname still names the same file. UTF-8 decoding and JSON parsing happen only after those checks.

A pathname replacement between the initial check and `open()`, an in-place mutation while bytes are being read, a symlink/directory/non-regular input, or malformed UTF-8/JSON therefore fails before model execution begins. Valid manifest structure and the public `verify_split()` API are unchanged.

Regression coverage is in `tools/tests/test_verify_split_onnx_manifest_snapshot.py`.
