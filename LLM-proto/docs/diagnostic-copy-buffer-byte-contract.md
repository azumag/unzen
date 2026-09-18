# Diagnostic copy/hash buffer byte contract

Diagnostic copy and hashing helpers use `buffer_bytes` only as a bounded I/O chunk size. It is a runtime control, not evidence data, and malformed values must fail before the helper touches source, payload, or output filesystem state.

For the endpoint payload materializer, every public or internal boundary that accepts `buffer_bytes` requires a positive Python `int` and explicitly rejects `bool`. Finite floats, fractional values, `NaN`, infinities, zero, and negative values are invalid even when Python comparison or truthiness would otherwise let them reach a later `read()` call.

Validation happens before the relevant side effect boundary. `sha256_file()` validates before opening the path; `_sha256_stream()` validates before descriptor or stream I/O; `_hash_source_and_materialize_ranges()` validates before source inspection or destination creation; and `materialize_source_payload_chunks()` plus the pinned-probe wrapper validate before blueprint/path/output work. Valid positive integers retain the existing digest, copy, snapshot-stability, cleanup, and report semantics.

The independent endpoint materialization verifier has the same contract as a follow-up part of issue #1080; producer-side hardening does not weaken or substitute for verifier-side validation.
