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

#### 2.B.1 Chrome Prompt API feasibility のGo/No-Go記録（#93）

standalone browser harness（`browser-harness/chrome-prompt-api/`）が実ブラウザで
計測し、report schema + validator（`src/chrome-prompt-api-report.ts`）が証明力を
判定します。**現時点では全項目 pending real-browser measurement（未解決条件）です。**
実測結果は主張しません。実測した場合は、captured-and-verified envelopeで検証された
結果のみ、この表の「現在の記録」を更新します。

| 条件 | 現在の記録 | `met`になる条件 |
|---|---|---|
| real-browser-evidence | **pending real-browser measurement** | artifact loader + independent verifierで検証された`captured-and-verified` envelope |
| prompt-api-availability | **pending real-browser measurement** | top-levelでavailabilityが`available` |
| create-after-user-activation | **pending real-browser measurement** | user activation内で`create()`成功 |
| first-download-preparation | **pending real-browser measurement** | 初回download完了と`downloadprogress`観測 |
| prompt-non-streaming | **pending real-browser measurement** | `prompt()`が計測付きで成功 |
| prompt-streaming | **pending real-browser measurement** | `promptStreaming()`がchunk計測付きで成功 |
| japanese-input-output | **pending real-browser measurement** | 日本語入力受付と日本語出力 |
| abort-interruption | **pending real-browser measurement** | `AbortSignal`で生成中断 |
| context-usage-and-overflow | **pending real-browser measurement** | context window取得とoverflow/quota処理 |
| session-lifecycle | **pending real-browser measurement** | destroy + re-create成功 |
| concurrent-sessions | **pending real-browser measurement** | 同時session実行エラーなし |
| surface-matrix | **pending real-browser measurement** | top-level / same-origin / sandbox iframeの記録 |

判定: `not-evaluated`（未解決条件）＝実ブラウザ検証済みevidenceなし（現状）。
`go`＝全条件met（captured-and-verified必須）。`conditional-go`＝一部pending/not-applicable。
`no-go`＝シナリオ失敗。手書きfixtureは`not-evaluated`から昇格できません。

- 詳細: [`docs/chrome-prompt-api-harness.md`](./docs/chrome-prompt-api-harness.md)

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
| deployed/browser/WebGPU系gate | evidence envelopeとdecision logicのvalidator | provenanceがなければ`contract-tested`。browser preview・pilot・telemetry gateはenvelope検証済みのみ受け付け |
| fleet SLO、reward、payout、tax | upstream reportからの判定・reconciliation logic | 主に`contract-tested` |
| Chrome Built-in AI | feasibility harness・report schema・Go/No-Go gate（#93） | `contract-tested`。実ブラウザ計測は未実施（未解決条件） |

最新状態はartifactとevidence envelopeに基づいて更新します。

## 4. Evidenceの読み方

### `synthetic-fixture`

mock、手書きobject、deterministic payloadでcontract・decision logicを確認します。

例:

- `synthetic-fixture` envelopeをbrowser preview / WebGPU pilot / telemetry gateへ渡し、`contract-tested`で判定する
- provider callback IDをfixtureへ設定してreconciliationを検証する
- session duration sampleを入力してretentionを計算する

これらは、実際のbrowser実行、provider callback、資金移動を証明しません。

`source: 'real-browser-*'` のような手書きフィールドはgateで受け付けません。各gateは`EvidenceEnvelope`を`validateEvidenceEnvelope()`で検証し、`captured-and-verified`へ昇格できるのはartifact loader・独立verifier・trust listが揃った場合だけです。

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
| Model Manifest | `src/model-manifest.ts` | versioned `SegmentedModelManifest` + manifest digest (#102)。segment geometryの唯一のsource of truth |
| Model Manifest Validator | `src/model-manifest-validator.ts` | 起動時fail-fast検証。placeholder hash・fixture manifestをreject (#102) |
| Browser Built-in Model | `src/browser-built-in-model.ts` | Chrome full-model backend descriptor。segment geometryを持たない (#92, #102) |
| WorkerPool | `src/worker-pool.ts` | Worker登録・heartbeat・選択・状態管理 |
| CheckpointStore | `src/checkpoint.ts` | checkpointの保存・取得 |
| Pipeline | `src/pipeline.ts` | 1 segment / 1 Workerのpipeline |
| SpanRouter | `src/span-router.ts` | 連続segmentを一つのWorkerへ割り当てるroute計算 |
| SpanPipeline | `src/span-pipeline.ts` | span単位のpipeline実行 |
| Coordinator | `src/coordinator.ts` | request受付とpipeline統括 |
| Durable Coordinator | `src/durable-coordinator.ts` | durable state・idempotency・request identity・retry/cancellationを備えたCoordinator (#103) |
| Durable Repository | `src/durable-repository.ts` | storage境界を分けたrepository interface + in-memory実装 (#103) |
| State machine | `src/request-state-machine.ts` | accepted→queued→leased→running→completed等の遷移を検証するreducer (#103) |
| Worker Registry | `src/worker-registry.ts` | connection世代ごとのworker登録・revoke・heartbeat policy (#103) |
| Lease Manager | `src/lease-manager.ts` | assignment identityとactive leaseの一致検証 (#103) |
| Inference Backend | `src/inference-backend.ts` | `WorkerCapability` / `InferenceEvent` / `InferenceBackend`契約。segmented・full-model・server-fallbackを同一のcapability routing inputにする抽象化 (#94) |
| Capability Validator | `src/inference-capability.ts` | `WorkerCapability`のruntime validation。schema version・unknown field policy・enum/range整合を検証 (#94) |
| Backend Registry | `src/backend-registry.ts` | capability predicateによるcandidate selection。backend固有型ではなくcapabilityでrouting (#94) |
| Legacy Worker Adapter | `src/legacy-worker-adapter.ts` | 旧Worker登録protocolをsegmented capabilityへ変換する一時adapter (#94) |

### Feasibility / measurement contracts

| モジュール | ファイル | 証拠の性質 |
|---|---|---|
| TwoWorkerPrototype | `src/two-worker-prototype.ts` | simulated fixture |
| AdaptiveChunkDispatcher | `src/adaptive-chunk-dispatcher.ts` | simulated telemetry |
| WebGPU30BFeasibility | `src/webgpu-30b-feasibility.ts` | metadata evaluation（`SegmentedModelManifest`を入力とする、#102） |
| ChromePromptApiFeasibility | `src/chrome-prompt-api-report.ts` | Chrome Prompt API harness report schema + validator + Go/No-Go gate（#93、実ブラウザ計測は別） |
| CheckpointTransferMeasurement | `src/checkpoint-transfer-measurement.ts` | deterministic payload / estimate |
| BrowserWorkerRetention | `src/browser-worker-retention.ts` | supplied session sample aggregation |
| CoordinatorPrototype | `src/coordinator-prototype.ts` | simulated Coordinator report |

### Workers / operations gates

`workers-coordinator-*` modulesは、Cloudflare Workers境界、signed runner、WebGPU telemetry、fleet SLO、publisher settlement、payout、tax operations等のreport contractとdecision logicを段階的に定義します。

名称に`real`または`production`が含まれていても、入力evidenceにprovenanceがなければLevel 1のcontract testです。各gateは、入力evidence levelを失わずdownstreamへ伝播させる必要があります。

| モジュール | ファイル | 証拠の性質 |
|---|---|---|
| Prototype harness | `src/workers-coordinator-prototype.ts` | simulated report |
| Miniflare smoke | `src/workers-coordinator-miniflare-smoke.ts` | workerd/Miniflare runtime smoke |
| Load-shaped smoke | `src/workers-coordinator-load-shaped-smoke.ts` | workerd/Miniflare runtime smoke |
| Deployed smoke | `src/workers-coordinator-deployed-smoke.ts` | authenticated Wrangler preview / deployed URL |
| Production observability canary | `src/workers-coordinator-production-observability-canary.ts` | deployed smoke reportの判定 |
| Signed runner release gate | `src/workers-coordinator-signed-runner-release-gate.ts` | CSP / sandbox / COOP / COEP contract |
| Signed runner browser preview | `src/workers-coordinator-signed-runner-browser-preview.ts` | browser evidence envelopeを検証 |
| Signed runner WebGPU worker pilot | `src/workers-coordinator-signed-runner-webgpu-worker-pilot.ts` | pilot evidence envelopeを検証 |
| WebGPU worker telemetry | `src/workers-coordinator-webgpu-worker-performance-telemetry.ts` | telemetry evidence envelopeを検証 |
| Fleet SLO / cost | `src/workers-coordinator-production-worker-fleet-slo-cost.ts` | upstream reportの判定 |
| Publisher reward settlement | `src/workers-coordinator-publisher-reward-settlement.ts` | upstream reportの判定 |
| Publisher ledger / payout reconciliation | `src/workers-coordinator-publisher-ledger-payout-reconciliation.ts` | upstream reportの判定 |
| Payout dry-run | `src/workers-coordinator-publisher-payout-dry-run.ts` | upstream reportの判定 |
| Live-money payout pilot | `src/workers-coordinator-publisher-live-money-payout-pilot.ts` | upstream reportの判定 |
| Recurring payout operations | `src/workers-coordinator-publisher-recurring-payout-operations.ts` | upstream reportの判定 |
| Revenue reporting | `src/workers-coordinator-publisher-revenue-reporting.ts` | upstream reportの判定 |
| Tax reporting | `src/workers-coordinator-publisher-tax-reporting.ts` | upstream reportの判定 |
| Tax filing delivery | `src/workers-coordinator-publisher-tax-filing-delivery.ts` | upstream reportの判定 |
| Tax provider sandbox filing | `src/workers-coordinator-publisher-tax-provider-sandbox-filing.ts` | upstream reportの判定 |
| Tax production cutover readiness | `src/workers-coordinator-publisher-tax-production-cutover-readiness.ts` | upstream reportの判定 |
| Tax production callbacks readiness | `src/workers-coordinator-publisher-tax-production-callbacks-readiness.ts` | upstream reportの判定 |
| Tax production monitoring reconciliation | `src/workers-coordinator-publisher-tax-production-monitoring-reconciliation.ts` | upstream reportの判定 |

signed runnerのbrowser preview・WebGPU worker pilot・telemetry gateは、`EvidenceEnvelope`と`validateEvidenceEnvelope()`を経由してのみ証拠を受け付けます。手書きfixtureは`captured-and-verified`へ到達できず、`contract-tested`に留まります。

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
npm test -- --run tests/model-manifest-validator.test.ts
npm test -- --run tests/browser-built-in-model.test.ts
npm test -- --run tests/checkpoint-transfer-measurement.test.ts
npm test -- --run tests/browser-worker-retention.test.ts
npm test -- --run tests/coordinator-prototype.test.ts
npm test -- --run tests/workers-coordinator-prototype.test.ts
npm run test:workers-signed-runner-gate
npm run test:workers-signed-runner-browser-preview
npm run test:workers-signed-runner-webgpu-worker-pilot
npm run test:workers-webgpu-telemetry
npm run test:chrome-prompt-api
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
npx vitest run tests/inference-backend.test.ts
npx vitest run tests/backend-registry.test.ts
npx vitest run tests/legacy-worker-adapter.test.ts
npx vitest run tests/browser-built-in-model.test.ts
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

- [#101](https://github.com/azumag/unzen/issues/101): simulated evidenceと実測evidenceの分離 — evidence envelope基盤(#108)とbrowser preview・WebGPU pilot・telemetry gateのenvelope検証移行で対応済み。残りは各gateの実証拠artifactの取得
- [#102](https://github.com/azumag/unzen/issues/102): hard-coded model geometryとplaceholder hashのmanifest化 — `SegmentedModelManifest` + 起動時fail-fast validatorで対応済み。30B/8segment/~2.1GBはEXAMPLE fixtureであり実測値ではない
- [#103](https://github.com/azumag/unzen/issues/103): durable request state、idempotency、retry、cancellation — `DurableCoordinator` + in-memory repositoryで対応（詳細は[`docs/coordinator-durability.md`](./docs/coordinator-durability.md)）
- [#94](https://github.com/azumag/unzen/issues/94): InferenceBackend / `WorkerCapability`抽象化 — segmented・full-model・server-fallbackを同一capabilityでrouting（詳細は[`docs/inference-backend-abstraction.md`](./docs/inference-backend-abstraction.md)）
- [#92](https://github.com/azumag/unzen/issues/92): Chrome Built-in AI backend（descriptorは`src/browser-built-in-model.ts`で定義済み）

これらが完了するまで、現在のgate chainをproduction-ready systemとは表現しません。

## 8. 既知の制約

- 30B、8 segment、約2.1GB/segment、約4秒/segment等は**仮定値を含むEXAMPLE**であり、実測値ではない。権威あるgeometryは`SegmentedModelManifest`が保持する
- `Coordinator`は検証済みの`SegmentedModelManifest`を注入され、起動時にplaceholder hash・fixture manifest・不整合geometryをrejectする（#102対応済み）
- 基本Coordinator/Pipelineはprocess-local stateを含み、production durabilityが未完成（`DurableCoordinator`は#103でdurable repository上に構築済み。production storage adapterは未実装）
- 基本Pipelineのtimeoutは`withAbortableTimeout`（`src/pipeline-utils.ts`）でunderlying executionをabortする設計に移行済み（#103）
- 手書きfixture fieldだけでは実行証拠にならない。browser preview・WebGPU pilot・telemetry gateはevidence envelopeの検証を必須とし、`contract-tested`以上へは昇格しない
- Prompt APIはdocument runner、Permission Policy、user activation等の実ブラウザ検証が未完了（feasibility harnessは#93で導入済み。計測・captured-and-verified evidenceは未取得）
- payout・tax gateは実providerの資金移動・申告完了を意味しない

## 9. 関連ドキュメント

| ドキュメント | 内容 | 状態 |
|---|---|---|
| [`PLAN.md`](./PLAN.md) | 確定方針とpipeline計画 | 設計基準。仮定値は実測値と区別する |
| [`docs/evidence-readiness.md`](./docs/evidence-readiness.md) | evidence levelとreadiness規約 | #108で導入、gate移行#101で適用 |
| [`docs/model-manifest.md`](./docs/model-manifest.md) | `SegmentedModelManifest` / validator / Chrome descriptor規約 | #102で導入 |
| [`docs/2b-two-worker-prototype.md`](./docs/2b-two-worker-prototype.md) | 2B / 2-worker milestone | contract harnessあり |
| [`docs/adaptive-chunk-dispatcher.md`](./docs/adaptive-chunk-dispatcher.md) | adaptive dispatcher | simulated logicあり |
| [`docs/webgpu-30b-partial-inference-feasibility.md`](./docs/webgpu-30b-partial-inference-feasibility.md) | 30B partial inferenceの判定項目 | metadata gateあり、実browser検証は別 |
| [`docs/checkpoint-transfer-measurement.md`](./docs/checkpoint-transfer-measurement.md) | checkpoint measurement | deterministic harnessあり |
| [`docs/browser-worker-retention-measurement.md`](./docs/browser-worker-retention-measurement.md) | retention measurement | sample aggregation harnessあり |
| [`docs/coordinator-prototype.md`](./docs/coordinator-prototype.md) | Coordinator prototype | simulated harnessあり |
| [`docs/coordinator-durability.md`](./docs/coordinator-durability.md) | Durable Coordinator (#103): durable state・idempotency・identity・retry/cancellation・checkpoint envelope | in-memory repository + durable Coordinator testでcontract検証 |
| [`docs/inference-backend-abstraction.md`](./docs/inference-backend-abstraction.md) | InferenceBackend / `WorkerCapability`抽象化 (#94): backend kind、capability validation、event union、capability routing、per-backend責任境界 | mock backend + routing unit testでcontract検証 |
| [`docs/workers-coordinator-prototype.md`](./docs/workers-coordinator-prototype.md) | Workers/operations gate chain | contractとruntime evidenceを区別して読む |
| [`docs/chrome-prompt-api-harness.md`](./docs/chrome-prompt-api-harness.md) | Chrome Prompt API feasibility harnessとmanual計測手順 | #93で導入。実測結果は未取得（未解決条件） |
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
