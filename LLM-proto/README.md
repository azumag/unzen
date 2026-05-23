# unzen (LLM-proto) 詳細設計書

## 1. 概要

「1つの巨大なモデルを1つのサーバーで動かす」という常識を破壊し、**「モデルを薄くスライスし、世界中のブラウザに持たせる」**ことで、超低コストな推論APIを実現します。

## 2. 技術アーキテクチャ：レイヤー・ストリーミング

LLMの各レイヤー（層）を「セグメント」として扱い、複数のWorker（閲覧者）を連ねて1つの推論を完成させる「パイプライン並列化」を採用します。

### A. モデルのスライスと配布

- **10MB Sharding**: 例えば7Bクラスのモデルを、1ブロック10MB程度の重みデータに分割します。
- **Role Assignment**: 各Workerには「あなたはLlama-3の1〜3層目担当」「あなたは4〜6層目担当」と役割を振ります。

### B. 推論リレーのフロー

1. **Prompt Input**: ユーザーがAPIにプロンプトを投げる。
2. **Entry Node**: 最初のWorkerが「第1セグメント」を計算。
3. **Relay (Coordinator経由)**: 計算後の中間データ（hidden states等）をCoordinatorに送信し、次のセグメント担当Workerへ中継（第三者通信禁止のため、Worker間の直接通信は行わない。PLAN.md 1.2項参照）。
4. **Token Generation**: 最後のWorkerがトークンを生成し、クライアントへ返す。

## 3. 「10MBの壁」を突破する3つのコア技術

### ① WebGPU による高速化

従来のJavaScriptではなく、GPUを直接叩くWebGPUを使用。Wasmよりもさらに数倍〜数十倍速い行列演算が可能になり、ブラウザでも「それなりの性能」の推論速度（数トークン/秒）を確保します。

### ② モデルの蒸留と量子化 (Quantization)

- **4-bit / 2-bit 量子化**: 重みデータを極限まで圧縮。
- **Speculative Decoding**: 軽量モデル（ブラウザ側）で下書きし、重量モデル（サーバー側）で検証する手法を組み合わせ、見かけ上の速度を上げます。

### ③ インテリジェント・キャッシュ

一度ダウンロードした10MBの重みは IndexedDB に保存。サイトを再訪した際はダウンロードなしで即座に計算に参加します。

## 4. 信頼性とセキュリティ

- **冗長リレー**: 重要な推論ステップでは、2つのルート（Aチーム・Bチーム）で同時にリレーを行い、結果を照合します。
- **プライバシー**: プロンプトは暗号化され、各Workerは自分が担当する「中間数値」しか見ることができないため、プロンプトの全文漏洩リスクを低減できます。

## 5. ビジネスとしてのポジショニング

| 項目 | 既存のAI API (OpenAI等) | あなたの分散型API |
|------|------------------------|------------------|
| **コスト構造** | 高価なH100/A100の維持費 | Webサイト閲覧者の余剰電力 |
| **価格帯** | 高い | 既存の1/10〜1/100を目指せる |
| **思想** | 中央集権・クローズド | 分散型・オープンウェイト |

## 6. パイプライン実装（プロトタイプ）

PLAN.md v2.6 Section 5 のチェックポイント・リジューム方式を TypeScript で実装したプロトタイプ。
Petals の分散パイプライン並列を参考に、ブラウザ WebGPU ワーカー向けに設計している。

### モジュール構成

| モジュール | ファイル | 概要 |
|---|---|---|
| 型定義 | `src/types.ts` | WorkerId, SegmentConfig, Checkpoint 等のコア型 |
| プロトコル | `src/protocol.ts` | Coordinator-Worker 間の WebSocket メッセージ定義（Span 対応含む） |
| CheckpointStore | `src/checkpoint.ts` | セグメント間の中間状態（hidden states）を保存・取得 |
| WorkerPool | `src/worker-pool.ts` | ブラウザワーカーのTier別管理・選択・死活監視 |
| Pipeline | `src/pipeline.ts` | 基本パイプライン：1セグメント/1ワーカーでチェックポイント・リジューム実行 |
| SpanRouter | `src/span-router.ts` | Petals 方式の貪欲ルーティング：ワーカーの VRAM に応じて連続セグメントを割り当て |
| AdaptiveChunkDispatcher | `src/adaptive-chunk-dispatcher.ts` | telemetry に基づく chunk length / dispatch score / rolling consecutive assignment の simulated 実行ロジック |
| WebGPU30BFeasibility | `src/webgpu-30b-feasibility.ts` | 30B-class partial inference の segment manifest / checkpoint / runtime metadata gate |
| CheckpointTransferMeasurement | `src/checkpoint-transfer-measurement.ts` | hidden states checkpoint の serialization / Coordinator transfer measurement gate |
| BrowserWorkerRetention | `src/browser-worker-retention.ts` | browser worker の session duration / churn / checkpoint resume impact measurement gate |
| CoordinatorPrototype | `src/coordinator-prototype.ts` | request lifecycle / heartbeat / adaptive assignment / checkpoint relay / retry-resume を束ねる simulated Coordinator gate |
| WorkersCoordinatorPrototype | `src/workers-coordinator-prototype.ts` | Cloudflare Workers 境界の API lifecycle / Durable Object state / WebSocket heartbeat p95 / checkpoint relay gate |
| SpanPipeline | `src/span-pipeline.ts` | Span パイプライン：SpanRouter でルート計算し、スパン単位で実行 |
| Pipeline Utils | `src/pipeline-utils.ts` | Pipeline/SpanPipeline 共通ユーティリティ（タイムアウト、遅延） |
| Coordinator | `src/coordinator.ts` | API受付・ワーカー管理・パイプライン実行を統括 |
| TwoWorkerPrototypeRunner | `src/two-worker-prototype.ts` | 2B / 2-worker milestone の simulated harness、reference 比較、checkpoint resume、run report |

### アーキテクチャ

#### 基本パイプライン（Pipeline）

```
API顧客 → Coordinator → [Seg0] → checkpoint → [Seg1] → ... → [Seg7] → 結果
               ↕ WebSocket                ↕
          WorkerPool (Tier 1/2/3)    CheckpointStore
```

#### Span パイプライン（SpanPipeline — Petals 方式）

```
API顧客 → Coordinator → SpanRouter でルート計算
                          ↓
           W1[Seg0-3] → checkpoint → W2[Seg4-5] → checkpoint → W3[Seg6-7] → 結果
           (1スパン内はGPUメモリ上で処理、チェックポイント転送不要)
```

Petals の分散パイプライン並列を参考に、1ワーカーが VRAM の許す限り連続セグメントを「スパン」として処理する。
これにより、例えば8セグメントを3スパンに統合すると、チェックポイント転送が7回→2回に削減される。

- **Tier 1**: 24h稼働デバイス（サイネージ等） — 最優先、大きなスパンを担当
- **Tier 2**: 長時間ワーカー（OBS、拡張機能、Electron） — 高優先
- **Tier 3**: 通常Web訪問者 — バースト対応、1-2セグメントのスパン

### テスト実行

```bash
cd LLM-proto
npm install
npm test
npm test -- --run tests/two-worker-prototype.test.ts
npm test -- --run tests/adaptive-chunk-dispatcher.test.ts
npm test -- --run tests/webgpu-30b-feasibility.test.ts
npm test -- --run tests/checkpoint-transfer-measurement.test.ts
npm test -- --run tests/browser-worker-retention.test.ts
npm test -- --run tests/coordinator-prototype.test.ts
npm test -- --run tests/workers-coordinator-prototype.test.ts
```

`TwoWorkerPrototypeRunner` は実モデルを読み込まず、mock segment artifact と allowlist transport で 2-worker split path の制御フローを固定する。
run report には segment latency、checkpoint byte size、cache hit、retry count、worker metadata、Coordinator/CDN 接続履歴が含まれる。

`AdaptiveChunkDispatcher` は実モデルを読み込まず、worker telemetry から selected chunk length と dispatch score を計算する。
run report には selected chunk length、score inputs、load readings、cache hit、retry count、checkpoint transfer timing、cold load / rolling consecutive state、Coordinator/CDN 接続履歴が含まれる。

`WebGPU30BFeasibility` は実モデルを読み込まず、30B-class segment manifest、checkpoint tensor shape、transfer timing、runtime candidate capability、AdaptiveChunkDispatcher の WorkerTelemetry 前提を metadata report として検証する。
manual browser/WebGPU validation checklist は `docs/webgpu-30b-partial-inference-feasibility.md` に置く。

`CheckpointTransferMeasurement` は実モデルを読み込まず、hidden states tensor shape / dtype から deterministic checkpoint payload を生成し、serialization time、deserialization time、Coordinator transfer estimate / observed duration、retry count、failure reason を report する。
manual browser/WebGPU checkpoint measurement path は `docs/checkpoint-transfer-measurement.md` に置く。

`BrowserWorkerRetention` は実モデルを読み込まず、session duration sample と segment 中離脱イベントから retention curve、p50/p95、early abandon、retry/resume impact、AdaptiveChunkDispatcher telemetry comparison、failure reason を report する。
manual browser retention measurement path は `docs/browser-worker-retention-measurement.md` に置く。

`CoordinatorPrototype` は実モデルを読み込まず、API request lifecycle、worker heartbeat / eligibility、AdaptiveChunkDispatcher assignment、Coordinator-mediated checkpoint relay、worker loss 時の retry/resume impact、failure reason を 1 つの report に束ねる。
Cloudflare Workers prototype へ進む前の focused gate と report fields は `docs/coordinator-prototype.md` に置く。

`WorkersCoordinatorPrototype` は実 Cloudflare Workers runtime を起動せず、API request lifecycle、Durable Object 相当の single-writer worker state、AdaptiveChunkDispatcher assignment report、Coordinator-owned checkpoint relay、worker loss retry/resume impact、failure reason を report する。
Workers boundary の WebSocket heartbeat p95、direct worker-to-worker rejection、実行手順、次 bottleneck は `docs/workers-coordinator-prototype.md` に置く。

## 関連ドキュメント

| ドキュメント | 内容 | ステータス |
|---|---|---|
| [PLAN.md](./PLAN.md) | 計画書 v2.6（確定方針・パイプライン方式） | **確定** |
| [docs/2b-two-worker-prototype.md](./docs/2b-two-worker-prototype.md) | 2Bクラスモデルを2ワーカー分割で動かす最初の実行仕様 | **harness 追加済み** |
| [docs/adaptive-chunk-dispatcher.md](./docs/adaptive-chunk-dispatcher.md) | ワーカー能力・稼働時間・余剰負荷に基づく adaptive chunk dispatcher 仕様 | **simulated dispatcher 追加済み** |
| [docs/webgpu-30b-partial-inference-feasibility.md](./docs/webgpu-30b-partial-inference-feasibility.md) | 30B 部分推論に進めるかを判定する WebGPU metadata/report gate | **metadata gate 追加済み** |
| [docs/checkpoint-transfer-measurement.md](./docs/checkpoint-transfer-measurement.md) | hidden states checkpoint の serialization / Coordinator transfer measurement gate | **measurement harness 追加済み** |
| [docs/browser-worker-retention-measurement.md](./docs/browser-worker-retention-measurement.md) | browser worker retention / churn / checkpoint resume impact measurement gate | **measurement harness 追加済み** |
| [docs/coordinator-prototype.md](./docs/coordinator-prototype.md) | API受付・worker heartbeat・assignment・checkpoint relay・retry/resume を束ねる Coordinator prototype gate | **simulated harness 追加済み** |
| [docs/workers-coordinator-prototype.md](./docs/workers-coordinator-prototype.md) | Cloudflare Workers Coordinator boundary の API lifecycle / Durable Object state / WebSocket heartbeat p95 / checkpoint relay gate | **prototype harness 追加済み** |
| [SWARM.md](./SWARM.md) | 群知能方式の設計書（軽量LLM × 分散合意） | 初版・実験的 |
| [docs/strategy-ensemble-inference.md](./docs/strategy-ensemble-inference.md) | 並列アンサンブル推論戦略案 | 検討中 |
| [docs/report-transformers-js-v4.md](./docs/report-transformers-js-v4.md) | Transformers.js v4 適用可能性調査レポート | 調査完了 |
| [docs/archive/](./docs/archive/ARCHIVE_INDEX.md) | 廃止ドキュメント一覧 | アーカイブ |
