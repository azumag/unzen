# Capture source graph hash boundary

`tools/capture_multi_segment_evidence_run.py` binds the source ONNX graph before split generation and rechecks it before numerical verification. Those two digests are part of the host-side evidence contract for Issue #167.

The capture runner now delegates byte hashing to `verify_multi_segment_artifacts.sha256_file()`. That verifier helper reads one opened regular-file descriptor and detects in-place mutation while the descriptor is being measured.

The verifier helper intentionally permits a pathname to be replaced after the descriptor is opened: its general artifact-integrity contract is to report the bytes of the descriptor it actually measured. The capture runner needs a stricter contract because its source pathname is used again by split generation and ONNX Runtime. Therefore the runner also records the pathname target identity (`st_dev`, `st_ino`) immediately before hashing and requires the same target immediately after hashing.

As a result, a same-content replacement cannot silently rebind the capture source between the digest operation and subsequent pathname-based work. The digest remains ordinary SHA-256 for a stable regular file, while a persistent pathname replacement during the hash boundary fails closed with `source model graph path changed while hashing`.

This boundary does not claim that all later ONNX Runtime access is descriptor-only. The runner still performs the existing post-generation digest comparison and artifact snapshot checks. The change only strengthens the source graph hash boundary without changing model splitting policy, browser artifact budgets, or evidence semantics.
