# Multi-segment cached-decode evidence accounting

The cached-decode evidence collector persists same-machine, `diagnostic-only` evidence for a prompt prefill followed by one decode step that reuses the split model's segment-local KV cache.

For the split path, `decode.splitPastCacheBytesConsumed` is not merely required to be non-zero. It must exactly equal `prompt.kvComparison.bytes` from the immediately preceding prompt step. The prompt KV comparison already fail-closes unless its reported byte count equals the sum of every canonical `present.<layer>.<key|value>` tensor, so this equality binds the decode consumption accounting to the concrete prompt KV evidence instead of trusting a standalone counter.

A mismatch is treated as structurally invalid evidence even when both values are non-zero. This protects persisted evidence against future verifier/accounting refactors that could accidentally report invented, partial, or stale consumed-byte totals.

This invariant is intentionally limited to the split path. It does not introduce a new requirement that the full-model and split-model cache byte counts match each other, does not change the verifier schema, and does not imply WebGPU, GPU-memory, multi-browser, Coordinator KV relay, worker-loss resume, or production-layout evidence.

The implementation lives in `tools/collect_multi_segment_kv_decode_evidence.py`, with regression coverage in `tools/tests/test_collect_multi_segment_kv_decode_evidence.py`.

## Offline verification of a published bundle

A persisted bundle can be checked without opening the ONNX model or split artifacts and without rerunning numerical inference:

```bash
python tools/verify_multi_segment_kv_decode_evidence.py /path/to/kv-decode-evidence.json
```

The verifier treats the JSON as untrusted input. It rejects symlinks and non-regular files, limits the input to 16 MiB by default, uses `O_NOFOLLOW` where the platform provides it, and compares device/inode/size/mtime/ctime before and after the read so replacement or mutation during verification fails closed. The limit can be changed with a positive integer `UNZEN_KV_DECODE_EVIDENCE_MAX_BYTES` value.

After a strict UTF-8/JSON decode, it validates the evidence schema/kind and `diagnostic-only` boundary, the UTC capture timestamp, typed reproduction parameters, and runtime/provider envelope. It then recomputes `verificationSha256` using the collector's canonical JSON encoding and re-runs the same fail-closed semantic binding used at collection time. Consequently, changing the embedded verifier report without updating its digest fails, while changing both the report and digest still fails when the result violates provider/token binding, artifact-integrity structure, segment-local KV ownership, no-Coordinator-KV-relay, boundary topology, comparison status, or prompt-KV/decode-consumption accounting.

A structurally valid evidence bundle whose numerical result is `fail` is still a successfully verified archive: the command reports `verified: true` together with `evidenceStatus: fail`. Verification success means that the stored bundle is internally self-consistent; it does not convert a failed measurement into a passing one.

This check is not an authenticity mechanism. Someone able to replace the complete JSON can replace its internal digests as well, and the offline verifier does not re-hash the external model/segment files or rerun ONNX Runtime. It therefore does **not** prove who produced the evidence, that the referenced artifacts still exist unchanged, WebGPU/GPU-memory behavior, multi-browser execution, Coordinator checkpoint relay, worker-loss resume, or suitability of any physical production layout.
