# Capture-bundle JSON snapshot bound

`tools/verify_multi_segment_capture_bundle.py` treats the published capture metadata as untrusted audit input. `run-summary.json` and `same-machine-evidence.json` are therefore read through one descriptor-backed stable snapshot rather than by pathname-only helpers.

The snapshot now also has an explicit 16 MiB metadata ceiling. The verifier rejects a file whose path or opened descriptor already reports a larger size before payload allocation. Reads are additionally capped at `limit + 1`, so a regular file that grows after open cannot make the verifier keep accumulating bytes indefinitely; crossing the ceiling fails closed.

A file exactly at the ceiling remains valid. For accepted inputs, the verifier preserves the existing guarantees: regular-file/no-symlink checks, path-to-descriptor identity binding, metadata stability checks before and after the read, strict UTF-8 JSON parsing, object-root validation, and SHA-256 over the exact accepted bytes.

This ceiling applies only to capture metadata JSON. It does not change ONNX graph/external-data browser artifact limits or the artifact snapshot verifier. It is a host-side audit reliability bound for #167, not a reader-isolation policy for #908 and not a production deployment decision.
