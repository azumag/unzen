# Numerical verifier manifest snapshot boundary

The same-machine multi-segment numerical gates in `tools/verify_multi_segment_onnx.py` and `tools/verify_multi_segment_kv_decode.py` rerun artifact-integrity preflight before creating ONNX Runtime sessions.

After that preflight, both verifiers still need the manifest JSON to validate the execution contract. This second read now reuses the artifact verifier's stable manifest reader instead of `Path.read_bytes()`: it opens the pathname read-only/nonblocking, requires a regular file, and rejects descriptor metadata drift while reading. The resulting bytes are used for both the preflight-digest comparison and JSON parsing.

This closes the remaining gap where the manifest pathname could be replaced with a FIFO, device, directory, or other non-regular object after preflight but before the numerical verifier's second read. Such inputs fail before any `onnxruntime.InferenceSession` is constructed.

The report schemas, numerical tolerances, and segment/KV execution semantics are unchanged; the cached-decode verifier remains `decisionStatus=diagnostic-only`. This is host-side correctness-gate hardening and is not new physical WebGPU or multi-browser evidence for #167.

Regression coverage is in `tools/tests/test_numerical_verifier_manifest_snapshot.py`.
