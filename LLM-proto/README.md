# unzen LLM-proto

ブラウザやクライアント端末を推論Workerとして利用する分散LLM基盤の設計・プロトタイプです。

> [!IMPORTANT]
> 現在の実装は、制御フロー、metadata評価、report schema、security/operations gateのcontract testが中心です。テスト名やreportの`pass`は、実ブラウザ、実モデル、実Worker fleet、実決済・税務処理が完了したことを意味しません。

証拠レベルとproduction readinessの定義は [`docs/evidence-readiness.md`](./docs/evidence-readiness.md) を参照してください。

## 1. 目的

Unzenは、広告や中央集権的な推論基盤だけに依存しないWebの収益・計算基盤を検討しています。

LLM-protoでは次を検証します。

- ブラウザWebGPUでモデルの一部を実行できるか
- Worker離脱時にcheckpointから再開できるか
- Worker能力・稼働時間・負荷に応じて割り当てを最適化できるか
- Coordinatorを通信・状態管理・securityの境界にできるか
- ユーザーの明示的オプトインと停止可能性を維持できるか
- サイト運営者への報酬を不正耐性のある形で計算できるか
- Chrome Built-in AI等、ブラウザ管理モデルを別backendとして利用できるか

## 2. 実装トラック

### A. Segmented WebGPU pipeline

Unzenが管理するモデルartifactをセグメントへ分け、複数Workerが順に処理します。

```text
API request
  → Coordinator
  → Worker A [segment 0..n]
  → checkpoint relay
  → Worker B [segment n+1..m]
  → ...
  → output
```

- Worker間の任意な直接通信は行わず、checkpointはCoordinator経由で中継する
- WorkerはVRAM、load、uptime、cache、failure history等から選択する
- Worker離脱時は直前checkpointから別Workerへ再割り当てする
- model geometry、segment size、latency、checkpoint sizeは仮定値と実測値を区別する

### B. Chrome Built-in AI full-model backend

Chromeが管理する端末内モデルを、一つのrequestを完結するfull-model Workerとして扱う計画です。

```text
user consent / user activation
  → Prompt API document runner
  → ChromeLanguageModelBackend
  → authenticated Coordinator bridge
  → whole-model routing
```

この経路はsegmented pipelineとは別backendです。

- layer range、model shard、checkpoint relayを要求しない
- Prompt API sessionはdocument contextが所有する
- availability、model preparation、streaming、abort、context、session lifecycleを扱う
- browser version、OS、hardware、execution surfaceごとの実ブラウザ検証が必要

実装計画は [Issue #92](https://github.com/azumag/unzen/issues/92) を参照してください。

### C. Swarm / ensemble experiments

軽量モデルを複数ノードで完全実行し、分散合意・アンサンブルを行う探索的トラックです。

- [`SWARM.md`](./SWARM.md)
- [`docs/strategy-ensemble-inference.md`](./docs/strategy-ensemble-inference.md)

## 3. 現在の成熟度

| 領域 | 実装されているもの | 現在の基本status |
|---|---|---|
| 基本Pipeline / SpanPipeline | Worker選択、segment実行、checkpoint、retryのTypeScript prototype | `contract-tested` |
| 2B / 2-worker milestone | mock segment artifactを使う比較・resume harness | `contract-tested` |
| AdaptiveChunkDispatcher | telemetry fixtureからchunk length・score・assignmentを計算 | `contract-tested` |
| 30B WebGPU feasibility | model/runtime/checkpoint metadataの判定 | `contract-tested` |
| checkpoint transfer | deterministic payloadのserializationとtransfer estimate | `contract-tested` |
| browser retention | session sampleからretention/retry影響を集計 | `contract-tested` |
| Coordinator prototype | API lifecycle、heartbeat、assignment、relayのsimulated report | `contract-tested` |
| Miniflare smoke | Miniflare/workerd上のfetch・storage・WebSocket境界 | `runtime-observed`（対象範囲限定） |
| deployed/browser/WebGPU系gate | evidence objectとdecision logicのvalidator | provenanceがない場合は`contract-tested` |
| fleet SLO、reward、payout、tax | upstream reportからの判定・reconciliation logic | 主に`contract-tested` |
| Chrome Built-in AI | feasibility・backend・UI/UX・E2EをIssue化 | `design-only` |

最新状態はartifactとevidence envelopeに基づいて更新します。

## 4. Evidenceの読み方

### `synthetic-fixture`

mock、手書きobject、deterministic payloadでcontract・decision logicを確認します。

例:

- `source: 'real-browser-webgpu-worker-pilot'` をfixtureへ設定してvalidatorを通す
- provider callback IDをfixtureへ設定してreconciliationを検証する
- session duration sampleを入力してretentionを計算する

これらは、実際のbrowser実行、provider callback、資金移動を証明しません。

### `self-reported-runtime`

実行環境自身が生成したreportです。local/manual integrationの診断には使えますが、digestや独立verificationがなければproduction判断の単独根拠にはしません。

### `captured-and-verified`

environment metadata、artifact locator、SHA-256、verifier、freshnessを持つ証拠です。compatibility、canary、SLO、production判断には原則このlevelを必要とします。

## 5. 主要モジュール

### Core pipeline

| モジュール | ファイル | 役割 |
|---|---|---|
| Types | `src/types.ts` | Worker、segment、checkpoint、request/resultの型 |
| Protocol | `src/protocol.ts` | Coordinator-Worker message contract |
| WorkerPool | `src/worker-pool.ts` | Worker登録・heartbeat・選択・状態管理 |
| CheckpointStore | `src/checkpoint.ts` | checkpointの保存・取得 |
| Pipeline | `src/pipeline.ts` | 1 segment / 1 Workerのpipeline |
| SpanRouter | `src/span-router.ts` | 連続segmentを一つのWorkerへ割り当てるroute計算 |
| SpanPipeline | `src/span-pipeline.ts` | span単位のpipeline実行 |
| Coordinator | `src/coordinator.ts` | request受付とpipeline統括 |

### Feasibility / measurement contracts

| モジュール | ファイル | 証拠の性質 |
|---|---|---|
| TwoWorkerPrototype | `src/two-worker-prototype.ts` | simulated fixture |
| AdaptiveChunkDispatcher | `src/adaptive-chunk-dispatcher.ts` | simulated telemetry |
| WebGPU30BFeasibility | `src/webgpu-30b-feasibility.ts` | metadata evaluation |
| CheckpointTransferMeasurement | `src/checkpoint-transfer-measurement.ts` | deterministic payload / estimate |
| BrowserWorkerRetention | `src/browser-worker-retention.ts` | supplied session sample aggregation |
| CoordinatorPrototype | `src/coordinator-prototype.ts` | simulated Coordinator report |

### Workers / operations gates

`workers-coordinator-*` modulesは、Cloudflare Workers境界、signed runner、WebGPU telemetry、fleet SLO、publisher settlement、payout、tax operations等のreport contractとdecision logicを段階的に定義します。

名称に`real`または`production`が含まれていても、入力evidenceにprovenanceがなければLevel 1のcontract testです。各gateは、入力evidence levelを失わずdownstreamへ伝播させる必要があります。

詳細:

- [`docs/workers-coordinator-prototype.md`](./docs/workers-coordinator-prototype.md)
- [`docs/evidence-readiness.md`](./docs/evidence-readiness.md)

## 6. テスト実行

```bash
cd LLM-proto
npm install
npm test
```

### Contract / simulated tests

以下は主にschema、制御フロー、decision logicを検証します。

```bash
npm test -- --run tests/two-worker-prototype.test.ts
npm test -- --run tests/adaptive-chunk-dispatcher.test.ts
npm test -- --run tests/webgpu-30b-feasibility.test.ts
npm test -- --run tests/checkpoint-transfer-measurement.test.ts
npm test -- --run tests/browser-worker-retention.test.ts
npm test -- --run tests/coordinator-prototype.test.ts
npm test -- --run tests/workers-coordinator-prototype.test.ts
npm run test:workers-signed-runner-gate
npm run test:workers-signed-runner-browser-preview
npm run test:workers-signed-runner-webgpu-worker-pilot
npm run test:workers-webgpu-telemetry
npm run test:workers-fleet-slo-cost
npm run test:workers-publisher-settlement
npm run test:workers-publisher-ledger
npm run test:workers-publisher-payout-dry-run
npm run test:workers-publisher-live-payout
npm run test:workers-publisher-recurring-payout
npm run test:workers-publisher-revenue-reporting
npm run test:workers-publisher-tax-reporting
npm run test:workers-publisher-tax-filing-delivery
npm run test:workers-publisher-tax-provider-sandbox
npm run test:workers-publisher-tax-production-cutover
npm run test:workers-publisher-tax-production-callbacks
npm run test:workers-publisher-tax-production-monitoring
```

### Runtime smoke

```bash
npm run test:workers-smoke
npm run test:workers-load-smoke
npm run test:workers-deployed-smoke
npm run test:workers-production-gate
```

runtime smokeも確認対象を限定して解釈します。たとえばMiniflare smokeの成功は、30B実モデルがbrowser WebGPUで動くことを証明しません。

## 7. 現在の重要な修正課題

- [#101](https://github.com/azumag/unzen/issues/101): simulated evidenceと実測evidenceの分離
- [#102](https://github.com/azumag/unzen/issues/102): hard-coded model geometryとplaceholder hashのmanifest化
- [#103](https://github.com/azumag/unzen/issues/103): durable request state、idempotency、retry、cancellation
- [#92](https://github.com/azumag/unzen/issues/92): Chrome Built-in AI backend

これらが完了するまで、現在のgate chainをproduction-ready systemとは表現しません。

## 8. 既知の制約

- 30B、8 segment、約2.1GB/segment、約4秒/segment等は仮定値を含む
- `Coordinator.buildSegmentConfigs()` にはmodel geometryとplaceholder hashのhard-codeが残る
- 基本Coordinator/Pipelineはprocess-local stateを含み、production durabilityが未完成
- timeoutがunderlying executionを必ずabortする設計には未移行
- real browser/WebGPUを示すfixture fieldだけでは実行証拠にならない
- Prompt APIはdocument runner、Permission Policy、user activation等の検証が未完了
- payout・tax gateは実providerの資金移動・申告完了を意味しない

## 9. 関連ドキュメント

| ドキュメント | 内容 | 状態 |
|---|---|---|
| [`PLAN.md`](./PLAN.md) | 確定方針とpipeline計画 | 設計基準。仮定値は実測値と区別する |
| [`docs/evidence-readiness.md`](./docs/evidence-readiness.md) | evidence levelとreadiness規約 | このPRで追加 |
| [`docs/2b-two-worker-prototype.md`](./docs/2b-two-worker-prototype.md) | 2B / 2-worker milestone | contract harnessあり |
| [`docs/adaptive-chunk-dispatcher.md`](./docs/adaptive-chunk-dispatcher.md) | adaptive dispatcher | simulated logicあり |
| [`docs/webgpu-30b-partial-inference-feasibility.md`](./docs/webgpu-30b-partial-inference-feasibility.md) | 30B partial inferenceの判定項目 | metadata gateあり、実browser検証は別 |
| [`docs/checkpoint-transfer-measurement.md`](./docs/checkpoint-transfer-measurement.md) | checkpoint measurement | deterministic harnessあり |
| [`docs/browser-worker-retention-measurement.md`](./docs/browser-worker-retention-measurement.md) | retention measurement | sample aggregation harnessあり |
| [`docs/coordinator-prototype.md`](./docs/coordinator-prototype.md) | Coordinator prototype | simulated harnessあり |
| [`docs/workers-coordinator-prototype.md`](./docs/workers-coordinator-prototype.md) | Workers/operations gate chain | contractとruntime evidenceを区別して読む |
| [`SWARM.md`](./SWARM.md) | swarm方式 | 実験的 |
| [`docs/report-transformers-js-v4.md`](./docs/report-transformers-js-v4.md) | Transformers.js v4調査 | 調査文書 |

## 10. Productionへ進む条件

最低限、以下をcaptured-and-verified evidenceで確認します。

- 対象browser/runtimeでの実推論
- model artifactとmanifest integrity
- Worker離脱・retry・cancel・late result
- Coordinator durable stateとidempotency
- sandbox、CSP、origin、network allowlistのnegative test
- user consent、pause、stop、revoke
- performance・quality・failure threshold
- canary、kill switch、rollback runbook
- payout・provider・tax関連は実environmentとoperator approval

条件未達の場合は`hold`または`not-evaluated`とし、contract testの`pass`で代替しません。
