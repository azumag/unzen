# Multi-segment capture source verification

Issue #167 の host-side capture bundle は、`tools/verify_multi_segment_capture_bundle.py` で公開後の bundle 内部整合性を再検証できる。一方、full ONNX graph と source external-data は capture directory へ複製しないため、bundle verifier だけでは「いま手元にある元モデルが、capture 時に数値比較した元モデルと同一か」は再確認しない。

`tools/verify_multi_segment_capture_source.py` はこの境界を埋める stdlib-only verifier である。ONNX Runtime を起動せず、公開済み capture bundle と caller が指定した元モデルを暗号学的に結び直す。

## 実行

`LLM-proto` から次を実行する。

```bash
python tools/verify_multi_segment_capture_source.py \
  --capture-dir /absolute/path/to/llama-1b-capture-001 \
  --full-model /absolute/path/to/model_q4.onnx
```

成功時は source graph / external-data の実測 identity を JSON で返す。

```json
{
  "schemaVersion": "1.0.0",
  "kind": "unzen-budgeted-multi-segment-capture-source-verification",
  "status": "pass",
  "captureStatus": "pass",
  "manifestSha256": "...",
  "sourceGraphBytes": 0,
  "sourceGraphSha256": "...",
  "sourceExternalDataCount": 1,
  "sourceExternalDataBytes": 0,
  "sourceExternalData": [
    {
      "location": "model_q4.onnx_data",
      "bytes": 0,
      "sha256": "..."
    }
  ]
}
```

## 検証内容

verifier は最初に既存の capture bundle verifier を再実行し、`run-summary.json`、`same-machine-evidence.json`、split manifest、generated segments が同一snapshotとして整合していることを要求する。その直後、control files を再hashして bundle verifier 実行後の差し替えも拒否する。

次に caller 指定の full model graph を再hashし、split manifest の `sourceModel.sha256`、capture bundle の `sourceGraphSha256`、embedded numerical verification の `sourceModel.graphSha256` と一致することを確認する。

source external-data は manifest に記録された全locationについて、relative-path安全性、重複、実byte数、canonical lowercase SHA-256 を確認し、実ファイルを再hashする。manifest の identity と embedded numerical verification の `sourceModel.externalData[]` も完全一致させる。`allExternalDataHashed=true` は必須である。

1B q4 の weight blob はhash中にも差し替えられ得るため、各source fileはhash前後の device / inode / byte size / mtime を比較し、検証途中のreplacementやmutationも fail-close する。

## Evidence boundary

この verifier の `status=pass` が意味するのは「published host-side capture bundle が、現在指定された original full-model artifact と同一identityを持つ」ということだけである。numerical capture 自体の pass/fail は `captureStatus` を保持し、real multi-browser WebGPU、Coordinator relay、cold/warm cache、worker-loss resume、SpanPipeline の実機evidenceを代替しない。
