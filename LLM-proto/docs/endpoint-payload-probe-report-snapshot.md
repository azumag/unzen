# Endpoint payload probe-report snapshot boundary

`tools/materialize_endpoint_payload_chunks.py` treats the pinned endpoint probe report as control input for diagnostic payload chunk selection. The report determines the exact source-byte ranges that may be copied from the pinned Llama 1B external-data file, so semantic validation alone is not sufficient if the pathname can resolve to different bytes between checks.

The CLI therefore reads `probe_report` from one descriptor-pinned snapshot. Before parsing JSON it requires a non-symlink regular file, bounds the input size, opens with no-follow/nonblocking flags where supported, verifies that the opened descriptor matches the pathname identity observed before open, and verifies the descriptor identity and byte count again after reading. The pathname is checked once more after the descriptor is closed so replacement during the read also fails closed.

JSON decoding and object validation operate only on the bytes read from that descriptor. Path replacement, non-regular input, invalid UTF-8/JSON, or mutation while reading fails before `materialize_pinned_probe_payload_chunks()` can create payload files.

This is host-side diagnostic input hardening only. It does not change the pinned probe semantics, chunk geometry, `decisionStatus=diagnostic-only`, source identity, report schema, or any browser artifact/cache/runtime/dispatcher decision. It also does not provide new real WebGPU or multi-browser evidence for #167.
