# Multi-segment capture bundle verification

Issue #167 の `tools/capture_multi_segment_evidence_run.py` が公開した host-side evidence bundle は、推論をもう一度実行しなくても `tools/verify_multi_segment_capture_bundle.py` で再検証できる。

この verifier は ONNX Runtime を起動しない。Python standard library と既存の stdlib-only `verify_multi_segment_artifacts.py` だけを使い、公開済み capture directory の各 evidence layer が同じ artifact snapshot を指していることを確認する。

## 実行

`LLM-proto` から、capture runner が完成させた directory を指定する。

```bash
python tools/verify_multi_segment_capture_bundle.py \
  --capture-dir /absolute/path/to/llama-1b-capture-001
```

成功時は JSON report を stdout に返す。

```json
{
  "schemaVersion": "1.0.0",
  "kind": "unzen-budgeted-multi-segment-capture-bundle-verification",
  "status": "pass",
  "captureStatus": "pass",
  "runSummarySha256": "...",
  "evidenceSha256": "...",
  "verificationSha256": "...",
  "manifestSha256": "...",
  "segmentCount": 6,
  "maximumSegmentArtifactBytes": 0,
  "effectiveRequiredMaxBytes": 268435456,
  "sourceGraphSha256": "..."
}
```

`captureStatus` は元の numerical capture の `pass` / `fail` を保持する。数値比較が tolerance 外で `captureStatus=fail` の bundle でも、bundle 自体の digest / identity が一貫していれば verifier の `status` は `pass` になる。ここでの `pass` は「保存された evidence が自己矛盾していない」という意味であり、numerical inference の成功を上書きしない。

## 検証内容

verifier は少なくとも次を fail-close で確認する。

1. `run-summary.json` の schema / kind / status。
2. `artifacts.manifest` と `evidence.path` が capture directory 内の安全な相対pathであること。absolute path、`..`、symlink escape は拒否する。
3. `verify_multi_segment_artifacts.py` を再実行し、全 segment graph / external-data の SHA-256、実byte数、artifact budgetを再測定する。
4. 再測定した manifest SHA-256、segment count、最大segment bytes、effective budget が `run-summary.json` と embedded numerical verification の両方に一致すること。
5. `same-machine-evidence.json` 自体の SHA-256 が `run-summary.json` に記録された値と一致すること。
6. embedded `verification` の canonical JSON SHA-256 が、evidence envelope と run summary の `verificationSha256` に一致すること。
7. run summary / evidence envelope / embedded verification の `status` が一致すること。
8. source graph SHA-256 が run summary と embedded verification で一致すること。
9. provider、input token IDs、KV heads、head size、`atol`、`rtol` が run summary と evidence envelopeで一致し、provider/token IDs は embedded verification とも一致すること。

これにより、capture directory 公開後に summary、evidence JSON、manifest、segment artifact のいずれかが差し替えられた場合、ONNX Runtime を起動せず検出できる。

## Evidence boundary

この verifier が証明するのは published host-side bundle の post-publication integrity と cross-file identity binding である。実 `Llama-3.2-1B-Instruct` q4 の numerical correctnessそのものは元の capture resultに従い、real multi-browser WebGPU、Coordinator relay、cold/warm cache、worker-loss resume、SpanPipeline の実機 evidence は別途必要になる。

したがって本reportを real browser evidence や production readiness と表現しない。
