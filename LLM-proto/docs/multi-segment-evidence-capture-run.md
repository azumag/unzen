# Multi-segment evidence capture run

Issue #167 の実 `Llama-3.2-1B-Instruct` q4 host-side evidence を、split生成・artifact integrity・full-vs-multi numerical verification に分けて手作業でつなぐ代わりに、`tools/capture_multi_segment_evidence_run.py` で一回の bounded run として取得できる。

このコマンドはモデルをダウンロードしない。既に取得済みの full ONNX graph と、その graph が参照する external-data file を入力にする。外部課金・Cloudflare・ブラウザ実機操作は行わない。

## 目的

実1B evidenceでは、途中の shard を別runのmanifestへ差し替えたり、source external-data hashing を誤って省略したり、preflight前後で別artifact setを使ったりしないことが重要になる。1B shard生成は長時間になり得るため、生成開始後に入力ONNX graph自体が置き換わり、in-memory graphとmanifest上のsource identityが別snapshotになることも許容しない。

capture runner は次を固定順序で行う。

1. shard生成前に source ONNX graph の SHA-256 を取得し、runの入力snapshotを固定する。
2. `prepare_budgeted_multi_split` で browser-budgeted shard を staging directory に生成する。
3. source external-data SHA-256 は常に有効化する。skip-digest経路はこのrunnerから利用できない。
4. 生成manifestの `sourceModel.sha256` と現在のsource graph SHA-256が手順1のdigestに一致することを確認する。生成中にsource graphが変化していれば、この時点でfail-closeし、artifact preflightやONNX Runtimeへ進まない。
5. `verify_artifact_snapshot` で生成manifest、segment graph、external-dataを stable filesystem snapshot として再測定する。このwrapperは既存の `verify_artifact_integrity` による実byte数・digest・browser budget検証を内包し、対応platformでは manifest directory をdescriptorでanchorして intermediate directory component も `dir_fd` / `O_NOFOLLOW` で辿る。
6. snapshot preflight が `pass` の場合だけ `collect_multi_segment_evidence` 相当の full-vs-multi numerical verification を実行する。
7. numerical verifier が内部で再取得した `artifactIntegrity` の manifest SHA-256、segment count、最大artifact bytes、effective budget が、手順5のsnapshot preflight内のintegrity reportと完全一致することを確認する。途中でartifact bytesが変化した場合は保存せずfail-closeする。
8. split artifacts、`same-machine-evidence.json`、`run-summary.json` を同じcapture directoryとして公開する。

planner / source graph snapshot check / snapshot preflight / verifier の例外、または preflight と numerical verifier の artifact identity 不一致では staging directory を削除し、指定された最終output directoryを残さない。数値比較が tolerance 外になった場合だけは、失敗そのものが調査価値のあるevidenceなので `status=fail` のbundleを公開し、CLI exit codeを非0にする。

snapshot verifier の `pathResolutionMode` は `run-summary.json` に保存する。`component-anchored-dirfd` は intermediate directory component までdescriptor-basedに固定できたrun、`final-component-only` はportable fallbackを意味する。後者を前者と同じ強度のfilesystem race evidenceとして扱わない。

plannerがbudget内のpartitionを作れない場合、errorには全segment-countを探索した `minimum achievable maximum` と、要求上限を超えるsingle-layer span（最大8件）を含める。これにより「cut数を増やせば解決する」のか、endpoint等の最小span自体がbudgetを超えていてgraph/artifact設計の変更が必要なのかを、artifact生成前に区別できる。

## 実行例

`LLM-proto` から実行する。

```bash
python tools/capture_multi_segment_evidence_run.py \
  --full-model /absolute/path/to/Llama-3.2-1B-Instruct/onnx/model_q4.onnx \
  --output-dir /absolute/path/to/llama-1b-capture-001 \
  --input-ids '128000,2028,374,264,1296' \
  --hidden-size 2048 \
  --target-bytes $((200 * 1024 * 1024)) \
  --preferred-max-bytes $((256 * 1024 * 1024)) \
  --provider CPUExecutionProvider \
  --kv-heads 8 \
  --head-size 64
```

`--output-dir` は既存pathを指定できない。既存evidenceやartifactを上書きしないため、runごとに新しいdirectoryを使う。

## 成功時の構成

```text
llama-1b-capture-001/
  run-summary.json
  same-machine-evidence.json
  split/
    split-manifest.json
    segment0.onnx
    segment0.onnx_data
    segment1.onnx
    segment1.onnx_data
    ...
```

segment数はplanner結果による。`run-summary.json` には少なくとも以下を保存する。

- capture parameters
- source graph SHA-256（shard生成前に固定した入力snapshot）
- manifest SHA-256
- segment count
- measured maximum segment artifact bytes
- effective required max bytes
- snapshot verifier schema/kind
- snapshot verifier `decisionStatus`
- snapshot verifier `pathResolutionMode`
- snapshot verifierがstable-readしたartifact file count
- same-machine evidence SHA-256
- embedded verification SHA-256
- final `pass` / `fail`

summary内部のpathはcapture rootからの相対pathに限定し、staging directoryの一時pathをevidenceへ残さない。summaryに記録するsource graph identityは生成前・生成manifest・生成直後の再hashが一致した場合だけ公開され、artifact byte identityはsnapshot preflightとnumerical verifier内の再preflightが一致した場合だけ公開される。

## 判定境界

このrunが `pass` しても、証明できるのは host-side / same-machine のartifact budgetとnumerical equivalenceまでである。

stable snapshot preflight は **preflight実行中** の manifest / graph / external-data replacement raceを強く検出するが、file descriptorを numerical verification 全体にわたって保持するtransactionではない。したがって、preflight完了後に同一内容の別inodeへ差し替え、numerical collectorの再preflight前後でも同じbytesを見せるような競合まで「同一filesystem instanceだった」と証明するものではない。run summaryのdigest/budget bindingは従来どおりbyte-level driftを検出する。

次は別途、実ブラウザWebGPUで以下を取得する必要がある。

- distinct browser workerでのmulti-segment continuation
- Coordinator-owned checkpoint relay
- direct worker networkingなし
- cold / warm cache差分
- relay / checkpoint latency
- worker loss / resume
- long-lived workerのmulti-artifact residencyとSpanPipeline assignment

したがって、このcapture bundleを real multi-browser WebGPU evidence や production readiness と表現しない。
