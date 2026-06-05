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
| WorkersCoordinatorMiniflareSmoke | `src/workers-coordinator-miniflare-smoke.ts` | Miniflare runtime の fetch / Durable Object storage / WebSocket heartbeat / load-shaped restart smoke gate |
| WorkersCoordinatorDeployedSmoke | `src/workers-coordinator-deployed-smoke.ts` | authenticated Wrangler preview / deployed Worker URL の fetch / browser WebSocket / edge placement smoke gate |
| WorkersCoordinatorProductionObservabilityCanary | `src/workers-coordinator-production-observability-canary.ts` | deployed smoke report から production metrics export / alert threshold / canary rollback gate を検証 |
| WorkersCoordinatorSignedRunnerReleaseGate | `src/workers-coordinator-signed-runner-release-gate.ts` | signed runner の CSP / sandbox iframe / COOP-COEP / network allowlist release gate を検証 |
| WorkersCoordinatorSignedRunnerBrowserPreview | `src/workers-coordinator-signed-runner-browser-preview.ts` | signed runner 境界を real browser harness と authenticated Wrangler preview / deployed Worker URL で検証 |
| WorkersCoordinatorSignedRunnerWebGpuWorkerPilot | `src/workers-coordinator-signed-runner-webgpu-worker-pilot.ts` | signed runner preview URL 上の real WebGPU worker segment execution / IndexedDB cache / checkpoint relay gate を検証 |
| WorkersCoordinatorWebGpuWorkerPerformanceTelemetry | `src/workers-coordinator-webgpu-worker-performance-telemetry.ts` | WebGPU worker の segment latency / cache timing / checkpoint relay duration / device loss / CPU fallback telemetry gate を検証 |
| WorkersCoordinatorProductionWorkerFleetSloCost | `src/workers-coordinator-production-worker-fleet-slo-cost.ts` | production worker fleet の device tier p95 / fallback rate / cache cost / checkpoint relay spend / opt-in impact gate を検証 |
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
npm run test:workers-smoke
npm run test:workers-load-smoke
npm run test:workers-deployed-smoke
npm run test:workers-production-gate
npm run test:workers-signed-runner-gate
npm run test:workers-signed-runner-browser-preview
npm run test:workers-signed-runner-webgpu-worker-pilot
npm run test:workers-webgpu-telemetry
npm run test:workers-fleet-slo-cost
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

`WorkersCoordinatorMiniflareSmoke` は Miniflare/workerd を起動し、`/api/requests` fetch endpoint、Durable Object storage、`/workers/:workerId/socket` WebSocket upgrade、direct worker-to-worker rejection を実ランタイムの smoke として検証する。
`test:workers-load-smoke` では複数の `/api/requests`、worker heartbeat churn、client-side WebSocket timing、Durable Object storage の再起動後 persistence も検証する。
`WorkersCoordinatorDeployedSmoke` は authenticated Wrangler preview / deployed Worker URL を対象に、auth header presence、Durable Object migration tag、real browser WebSocket timing、edge placement variance、direct worker-to-worker rejection を同じ report contract で検証する。
`WorkersCoordinatorProductionObservabilityCanary` は deployed smoke report を入力に、durable per-request metrics export、browser WebSocket p95 / edge placement variance / direct worker-to-worker rejection / upstream failure reason の alert threshold、canary promote/hold/rollback decision、Coordinator-owned checkpoint boundary preservation を検証する。
`WorkersCoordinatorSignedRunnerReleaseGate` は production canary の clean promote を前提に、signed runner delivery の CSP connect-src、sandbox iframe allow-scripts 境界、top-level DOM / Cookie / Storage 非依存、COOP / COEP header、Coordinator / CDN 以外への network attempt blocking を検証する。
`WorkersCoordinatorSignedRunnerBrowserPreview` は同じ signed runner delivery 境界を real browser harness の authenticated Wrangler preview / deployed Worker URL evidence に通し、runner URL、CSP connect-src、sandbox flags、COOP / COEP headers、allowed origins、blocked non-Coordinator/CDN network attempt、failure reason を report 化する。
`WorkersCoordinatorSignedRunnerWebGpuWorkerPilot` は browser preview gate を前提に、signed runner iframe 内の dedicated WebGPU worker が model segment execution を完了し、IndexedDB cache と Coordinator-owned checkpoint relay が top-level DOM / Cookie / Storage に依存しないことを report 化する。
`WorkersCoordinatorWebGpuWorkerPerformanceTelemetry` は WebGPU worker pilot gate を前提に、segment latency distribution、IndexedDB cache hit/miss timing、Coordinator checkpoint relay duration/retry/failure reasons、WebGPU device loss handling、CPU fallback routing、計測中の signed runner security boundary を report 化する。
`WorkersCoordinatorProductionWorkerFleetSloCost` は WebGPU worker telemetry gate を前提に、device tier 別 p95 latency、WebGPU device loss / CPU fallback rate、IndexedDB cache warmup cost、Coordinator checkpoint relay spend、user opt-in impact、promote/hold thresholds、fleet 集計中の signed runner security boundary を report 化する。
focused commands、report fields、次の real-runtime bottleneck は `docs/workers-coordinator-prototype.md` に置く。

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
| [docs/workers-coordinator-prototype.md](./docs/workers-coordinator-prototype.md) | Cloudflare Workers Coordinator boundary の API lifecycle / Durable Object state / WebSocket heartbeat p95 / deployed runtime smoke / production observability canary / signed runner browser preview / WebGPU worker telemetry / production fleet SLO-cost gate | **production fleet SLO-cost gate 追加済み** |
| [SWARM.md](./SWARM.md) | 群知能方式の設計書（軽量LLM × 分散合意） | 初版・実験的 |
| [docs/strategy-ensemble-inference.md](./docs/strategy-ensemble-inference.md) | 並列アンサンブル推論戦略案 | 検討中 |
| [docs/report-transformers-js-v4.md](./docs/report-transformers-js-v4.md) | Transformers.js v4 適用可能性調査レポート | 調査完了 |
| [docs/archive/](./docs/archive/ARCHIVE_INDEX.md) | 廃止ドキュメント一覧 | アーカイブ |
