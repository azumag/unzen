# Capture-source legacy JSON helper

`tools/verify_multi_segment_capture_source.py::_json_object()` is retained as a private compatibility helper, but it must not introduce a weaker pathname-based JSON read than the active capture-source verification path.

The helper therefore delegates to `_stable_json_object()` from `verify_multi_segment_capture_source_provenance.py` and only projects the parsed object from that reader's `(object, sha256)` result. This means legacy callers inherit the same bounded, non-symlink regular-file checks, descriptor-pinned read, pathname identity recheck, strict UTF-8 decoding, JSON-object validation, and fail-closed handling for replacement or mutation during the read.

The active `verify_capture_source()` path already uses `_stable_json_object()` directly and is intentionally unchanged. This hardening only prevents future reuse of the legacy helper from reintroducing the old `Path.is_file()` followed by `Path.read_text()` validate-then-reopen pattern.

Regression coverage is in `tools/tests/test_verify_multi_segment_capture_source_legacy_json.py`.
