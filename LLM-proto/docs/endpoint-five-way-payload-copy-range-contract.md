# Five-way endpoint payload copy-range contract

`tools/prepare_llama_1b_endpoint_five_way_tile_ort_webgpu.py` materializes the diagnostic five-way physical payloads from bounded ranges of the descriptor-pinned source external-data file.

The lower-level `_copy_source_range()` helper treats `source_offset` and `length` as runtime controls rather than relying on type annotations or on validation performed by `prepare()`. `source_offset` must be an exact non-negative Python `int`, and `length` must be an exact positive Python `int`. Booleans, negative values where disallowed, zero length, floats including `NaN` and infinities, strings, and other non-integers fail before the destination is opened and before `os.pread()` is called.

This preserves the existing valid behavior: source offset `0` is allowed, positive ranges copy and hash exactly the requested bytes, and a source that ends before the requested range still fails with the existing unexpected-EOF error. The helper does not independently establish the identity of `source_fd`; `prepare()` continues to obtain that descriptor from the pinned-source verification boundary.

On a copy failure after exclusive destination creation, the helper makes a best-effort removal of the newly-created partial path and then re-raises the original exception. A destination that already existed before the `"xb"` open attempt is never removed or replaced. If cleanup itself fails, the original copy failure remains authoritative and the partial path may remain for operator/tool cleanup rather than being hidden by a secondary cleanup error.

This is host-side diagnostic hardening only. It does not select the five-way layout, alter manifest/cache/runtime contracts, or add physical WebGPU evidence.
