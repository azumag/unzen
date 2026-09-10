# Multi-segment cached-decode evidence accounting

The cached-decode evidence collector persists same-machine, `diagnostic-only` evidence for a prompt prefill followed by one decode step that reuses the split model's segment-local KV cache.

For the split path, `decode.splitPastCacheBytesConsumed` is not merely required to be non-zero. It must exactly equal `prompt.kvComparison.bytes` from the immediately preceding prompt step. The prompt KV comparison already fail-closes unless its reported byte count equals the sum of every canonical `present.<layer>.<key|value>` tensor, so this equality binds the decode consumption accounting to the concrete prompt KV evidence instead of trusting a standalone counter.

A mismatch is treated as structurally invalid evidence even when both values are non-zero. This protects persisted evidence against future verifier/accounting refactors that could accidentally report invented, partial, or stale consumed-byte totals.

This invariant is intentionally limited to the split path. It does not introduce a new requirement that the full-model and split-model cache byte counts match each other, does not change the verifier schema, and does not imply WebGPU, GPU-memory, multi-browser, Coordinator KV relay, worker-loss resume, or production-layout evidence.

The implementation lives in `tools/collect_multi_segment_kv_decode_evidence.py`, with regression coverage in `tools/tests/test_collect_multi_segment_kv_decode_evidence.py`.
