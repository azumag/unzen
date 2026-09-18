# Diagnostic copy/hash buffer byte contract

Diagnostic copy and hashing helpers use `buffer_bytes` only as a bounded I/O chunk size. It is a runtime control, not evidence data, and malformed values must fail before the helper touches source, payload, or output filesystem state.

For both the endpoint payload materializer and its independent verifier, every public or internal boundary that accepts `buffer_bytes` requires a positive Python `int` and explicitly rejects `bool`. Finite floats, fractional values, `NaN`, infinities, zero, and negative values are invalid even when Python comparison or truthiness would otherwise let them reach a later `read()` call.

Validation happens before the relevant side effect boundary. On the producer side, `sha256_file()` validates before opening the path; `_sha256_stream()` validates before descriptor or stream I/O; `_hash_source_and_materialize_ranges()` validates before source inspection or destination creation; and the public materializer wrappers validate before blueprint/path/output work. On the verifier side, `_sha256_payload_at()` validates before payload open, `_sha256_file_and_ranges()` validates before range iteration or source open, and both verification entry points validate before report/blueprint/path/filesystem work. Valid positive integers retain the existing digest, copy, snapshot-stability, cleanup, verification, and report semantics.

Producer and verifier validation remain independent defense-in-depth boundaries. Neither report nor artifact formats are changed by this contract.
