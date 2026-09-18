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
  "runSummarySha256": "...",
  "manifestSha256": "...",
  "evidenceSha256": "...",
  "verificationSha256": "...",
  "sourcePathResolutionMode": "component-anchored-dirfd",
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

verifier は最初に既存の capture bundle verifier を再実行し、`run-summary.json`、`same-machine-evidence.json`、split manifest、generated segments が同一snapshotとして整合していることを要求する。その直後、`run-summary.json` とそこから選択された split manifest を descriptor-stable な bounded JSON snapshot として再読し、bundle verifier が返した `runSummarySha256` / `manifestSha256` と一致させる。このため bundle verifier 終了後から source rebind 開始までの control-file 差し替えを拒否する。

次に caller 指定の full model graph を再hashし、split manifest の `sourceModel.sha256`、capture bundle の `sourceGraphSha256`、embedded numerical verification の `sourceModel.graphSha256` と一致することを確認する。

source external-data は manifest に記録された全locationについて、relative-path安全性、重複、実byte数、canonical lowercase SHA-256 を確認し、実ファイルを再hashする。path text は filesystem 解決より前に canonical component 形を要求し、U+0000..U+001F の C0 control と U+007F DEL を拒否する一方、通常の非ASCII / UTF-8名は許容する。manifest の identity と embedded numerical verification の `sourceModel.externalData[]` も完全一致させる。`allExternalDataHashed=true` は必須である。offline の `verify_multi_segment_capture_source_provenance.py` も同じ lexical control-character 境界を共有する。

1B q4 の graph / weight blob はhash中にも差し替えられ得るため、source artifact は final symlink と非regular file を拒否し、すでにopenした file descriptor から直接 SHA-256 を計算する。対応OSでは `O_NOFOLLOW` / `O_CLOEXEC` / `O_NONBLOCK` を用い、source root を一度 anchor した上で graph / external-data の各 path component を no-follow で辿る。各fileは path check -> open -> fstat -> fd hash -> fstat -> path recheck の区間で device / inode / byte size / mtime / ctime が変わっていないことを要求する。これにより、同じ内容を持つ別inodeへのpathname replacementもdigest一致だけで通過しない。対応OSでは declared source-model root の final component 自体も symlink を許容しない。portable fallback は final component の stable-file check を維持する。

source rebind と embedded evidence の照合が完了した後、success report を返す直前に `run-summary.json`、選択済み split manifest、`same-machine-evidence.json` をもう一度 bounded / descriptor-stable snapshot として読む。各最終digestは、最初の bundle verifier が確定した `runSummarySha256` / `manifestSha256` / `evidenceSha256` と一致しなければならない。これにより、multi-gigabyte source hash の途中で control namespace が別byte snapshotへ更新され、その状態のまま verifier が成功することを防ぐ。途中で一時的に別inodeへ置換されても最終byte snapshotが完全に同一なら同じdigest identityとして扱うため、これは長時間のpathname inode lockではない。

この start/end control-snapshot binding は generated segment path の reader snapshot isolation を提供するものではない。artifact publication 中に既に旧manifestを読んだconsumerへ旧component namespaceを保持するかどうかは #908 の別設計判断であり、この verifier は publication layout や browser cache key を変更しない。

## Evidence boundary

この verifier の `status=pass` が意味するのは「published host-side capture bundle の control byte snapshot と、現在指定された original full-model artifact のidentityが、source rebind完了時点でも整合している」ということだけである。numerical capture 自体の pass/fail は `captureStatus` を保持し、real multi-browser WebGPU、Coordinator relay、cold/warm cache、worker-loss resume、SpanPipeline の実機evidenceを代替しない。

file descriptor からhashするため、source artifact のhash中にpathnameを一時的に別fileへ向けても読み取るbytesはopen済みinodeに固定される。ただしこの verifier はsource artifactの署名やevidence authorの真正性を証明するものではなく、production physical layoutやartifact policyを採用する判断にも使わない。
