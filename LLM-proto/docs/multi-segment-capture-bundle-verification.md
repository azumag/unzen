# Multi-segment capture bundle verification

Issue #167 の `tools/capture_multi_segment_evidence_run.py` が公開した host-side evidence bundle は、推論をもう一度実行しなくても `tools/verify_multi_segment_capture_bundle.py` で再検証できる。

この verifier は ONNX Runtime を起動しない。Python standard library と stdlib-only の `verify_multi_segment_artifact_snapshot.py` / `verify_multi_segment_artifacts.py` を使い、公開済み capture directory の各 evidence layer が同じ byte-level artifact snapshot を指していることを確認する。artifact再測定そのものも stable-snapshot verifier 経由で行う。

## 実行

`LLM-proto` から、capture runner が完成させた directory を指定する。

```bash
python tools/verify_multi_segment_capture_bundle.py \
  --capture-dir /absolute/path/to/llama-1b-capture-001
```

成功時は JSON report を stdout に返す。

```json
{
  "schemaVersion": "1.1.0",
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
  "captureSnapshotPathResolutionMode": "component-anchored-dirfd",
  "auditSnapshotPathResolutionMode": "component-anchored-dirfd",
  "sourceGraphSha256": "..."
}
```

`captureStatus` は元の numerical capture の `pass` / `fail` を保持する。数値比較が tolerance 外で `captureStatus=fail` の bundle でも、bundle 自体の digest / identity が一貫していれば verifier の `status` は `pass` になる。ここでの `pass` は「保存された evidence が自己矛盾していない」という意味であり、numerical inference の成功を上書きしない。

`captureSnapshotPathResolutionMode` は capture runner が記録した preflight mode、`auditSnapshotPathResolutionMode` は今回の offline audit host で実際に使えた mode である。capture と audit を別OS/platformで行う場合があるため、この2つは同一である必要はない。`component-anchored-dirfd` は intermediate directory component までdescriptor-basedに辿れたこと、`final-component-only` はportable fallbackを意味する。

capture runner の `run-summary.json` は既存bundleとの互換性を保つため schema `1.0.0` のまま、`artifacts.snapshotPreflight` を additive metadata として追加している。今回の変更より前に取得された schema `1.0.0` bundle にはこのfieldがないが、それらも引き続き監査できる。その場合 verifier は現在のartifactに対してstable snapshot auditを実行し、`captureSnapshotPathResolutionMode: null`、`auditSnapshotPathResolutionMode: <今回実際に使えたmode>` と返す。過去runで記録されていないcapture-time modeを推測・捏造しない。

## 検証内容

verifier は少なくとも次を fail-close で確認する。

1. `run-summary.json` の schema / kind / status。
2. `artifacts.manifest` と `evidence.path` が capture directory 内の安全な相対pathであること。absolute path、`..`、symlink escape は拒否する。
3. `verify_multi_segment_artifact_snapshot.py` を再実行し、manifest / segment graph / external-data を stable-read したうえで、内包する integrity verifier により SHA-256、実byte数、artifact budgetを再測定する。
4. `snapshotPreflight` が記録されている新しいcaptureでは、snapshot verifier schema/kind/decisionStatus/pathResolutionMode/artifactFileCount が contract上妥当で、artifactFileCount が今回の再測定とも一致すること。fieldがないlegacy captureは拒否せず、capture-time modeをunknownとして扱う。
5. 再測定した manifest SHA-256、segment count、最大segment bytes、effective budget が `run-summary.json` と embedded numerical verification の両方に一致すること。
6. `same-machine-evidence.json` 自体の SHA-256 が `run-summary.json` に記録された値と一致すること。
7. embedded `verification` の canonical JSON SHA-256 が、evidence envelope と run summary の `verificationSha256` に一致すること。
8. run summary / evidence envelope / embedded verification の `status` が一致すること。
9. source graph SHA-256 が run summary と embedded verification で一致すること。
10. provider、input token IDs、KV heads、head size、`atol`、`rtol` が run summary と evidence envelopeで一致し、provider/token IDs は embedded verification とも一致すること。

これにより、capture directory 公開後に summary、evidence JSON、manifest、segment artifact のいずれかが差し替えられた場合、ONNX Runtime を起動せず検出できる。対応platformでは artifact verifier 自体の実行中に生じる intermediate-directory replacement / symlink race も component-anchored mode でfail-closeする。

## Evidence boundary

この verifier が証明するのは published host-side bundle の post-publication integrity と cross-file identity binding である。capture時の `pathResolutionMode` は run summary に記録された metadata であり、署名された独立snapshot reportではない。また、capture preflightから numerical verification 全体まで同じ file descriptor を保持するtransactionでもないため、capture中のあらゆる same-content inode replacement を証明対象にはしない。legacy bundleで `captureSnapshotPathResolutionMode=null` の場合、現在のoffline auditが強いmodeで成功しても、過去のcapture時にも同じmodeが使われたとは扱わない。

実 `Llama-3.2-1B-Instruct` q4 の numerical correctnessそのものは元の capture resultに従い、real multi-browser WebGPU、Coordinator relay、cold/warm cache、worker-loss resume、SpanPipeline の実機 evidence は別途必要になる。

したがって本reportを real browser evidence や production readiness と表現しない。
