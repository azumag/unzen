# Two-segment verification manifest snapshot

`tools/verify_split_onnx.py` uses `split-manifest.json` as control input for the same-machine numerical correctness gate. Boundary tensor names and the logits output determine how the full model and the two generated ONNX segments are executed, so those routing values must come from one stable filesystem object.

The public `verify_split()` boundary first validates and snapshots its runtime controls before touching the manifest or creating an ONNX Runtime session. Token IDs must be non-negative integers and are consumed exactly once, the provider must be a non-empty name, KV-head/head-size values must be positive non-boolean integers, and `atol` / `rtol` must be finite non-negative numbers. This keeps `NaN` / infinite tolerances or malformed cache dimensions from weakening the numerical gate or triggering expensive model work before configuration failure.

After that runtime preflight, the verifier opens the manifest as a non-symlink regular file, binds the pathname metadata to the opened descriptor, reads all bytes from that descriptor, verifies that descriptor metadata did not change during the read, and then rechecks that the pathname still names the same file. UTF-8 decoding and JSON parsing happen only after those checks and still before any ONNX Runtime session is created.

A pathname replacement between the initial check and `open()`, an in-place mutation while bytes are being read, a symlink/directory/non-regular input, malformed UTF-8/JSON, or malformed runtime controls therefore fails before model execution begins. Valid runtime values and manifest structure remain otherwise unchanged.

Regression coverage is in `tools/tests/test_verify_split_onnx_manifest_snapshot.py` and `tools/tests/test_verify_split_onnx_runtime_preflight.py`.
