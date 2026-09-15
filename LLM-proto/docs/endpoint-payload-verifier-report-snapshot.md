# Endpoint payload verifier input-report snapshot boundary

`tools/verify_endpoint_payload_materialization.py` independently verifies diagnostic endpoint payload evidence. Its `probe_report` and producer `materialization_report` are control inputs: they select the verifier-owned pinned blueprint and declare the evidence being checked, while their exact SHA-256 digests are emitted in `inputReports`.

Each report is therefore read from one bounded non-symlink regular-file descriptor. The verifier checks pathname identity before open, descriptor identity after open, descriptor identity and byte count after the read, and pathname identity again after close. Path replacement, non-regular input, growth beyond the input bound, or mutation while reading fails closed before source/payload verification begins.

JSON decoding and SHA-256 are both derived from exactly the bytes captured by that descriptor. This preserves the verifier's independence from producer-side parsing helpers while making the reported input digest cryptographically bind the same bytes whose JSON semantics were verified.

This change is host-side diagnostic verifier hardening only. It does not change pinned endpoint geometry, artifact policy, `decisionStatus=diagnostic-only`, or any browser cache/manifest/loader/runtime/dispatcher decision, and it is not new physical WebGPU or multi-browser evidence for #167.
