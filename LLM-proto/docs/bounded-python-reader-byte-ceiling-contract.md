# Bounded Python reader byte-ceiling contract

Host-side Python helpers that accept a `max_bytes` argument treat that value as a runtime trust boundary, not as a best-effort hint.

For every bounded reader covered by this contract, `max_bytes` must be a positive Python `int`; `bool` is rejected even though it subclasses `int`. Finite floats, fractional values, `NaN`, infinities, zero, and negative values are invalid. Validation must happen before path expansion/resolution that can touch the filesystem, `lstat`, descriptor open, allocation, or payload reads. This prevents values such as `NaN` from bypassing ordinary size comparisons and silently disabling a byte ceiling.

An exact positive-integer boundary remains valid: an input whose byte length is exactly `max_bytes` is accepted, while an input larger than the limit is rejected. Existing regular-file, symlink, descriptor-identity, mutation, and digest semantics remain unchanged.

Bounded readers that consume report or source bytes through `os.read()` request `getattr(os, "O_BINARY", 0)` for regular-file descriptors. This is a no-op on POSIX and prevents Windows CRT text-mode translation from changing CRLF or control bytes underneath `st_size` byte-count checks or SHA-256 bindings. Directory descriptors are not covered by this binary-file flag.

## Current coverage

The following helpers follow this contract and have focused regression coverage for malformed limits, fail-before-filesystem behavior, exact-boundary acceptance, over-limit rejection, and their existing snapshot mutation checks. Raw-byte descriptor readers additionally prove the binary-open flag, and digest-bearing readers bind SHA-256 to the exact persisted byte stream:

- `tools/diagnose_multi_segment_budget.py::_read_source_graph_snapshot()`
- `tools/multi_segment_onnx.py::_read_source_graph_snapshot()`
- `tools/materialize_endpoint_payload_chunks.py::_read_probe_report_snapshot()`
- `tools/verify_endpoint_payload_materialization.py::_load_json_with_sha256()`

Issues #1075 and #1135 track the audits that aligned these bounded readers with the validation and raw-byte rules.

This hardening is local input-validation and byte-identity work. It does not change production deployment, browser artifact policy, publication concurrency, or legacy durable deadline semantics.
