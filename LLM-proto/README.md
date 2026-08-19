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

> 破棄済み（2026-08-06）: Chrome Built-in AI / Prompt API を別backendとして
> 利用する方針（トラックB、issues #92/#93/#95/#100）は、実ブラウザ計測で
> 特別な設定（フラグ・エンタープライズポリシー）なしには API が露出しない
> ことが確認されたため破棄しました。関連コード（`ChromeLanguageModelBackend`、
> `chrome-prompt-api-report.ts`、`browser-built-in-model.ts`、
> `browser-harness/chrome-prompt-api/` 等）は削除済みです。#94 の
> `browser-built-in-full-model` kind は抽象化としてのみ残ります。

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

### B. Chrome Built-in AI full-model backend — **破棄**

Chromeが管理する端末内モデルを、一つのrequestを完結するfull-model Workerとして
扱う計画でしたが、**2026-08-06 に破棄**しました。実ブラウザ計測（#93）で、
Chrome 150 stable / 153 Canary のいずれもフラグやエンタープライズポリシーの
特別な設定なしには `window.ai`（Prompt API）が露出しないことを確認したため、
「設定不要で動くWeb収益化インフラ」の要件を満たせないと判断しました。

- 破棄対象: issues #92（Chrome Built-in AI backend）、#93（feasibility harness）、
  #95（ChromeLanguageModelBackend 実装）、#100（E2E / 互換性matrix）
- 削除済み: `src/chrome-language-model-backend.ts`、`src/chrome-prompt-api-adapter.ts`、
  `src/chrome-prompt-api-report.ts`、`src/browser-built-in-model.ts`、
  `browser-harness/chrome-prompt-api/`、関連テスト・docs（`docs/chrome-prompt-api-harness.md` 等）
- 残存: #94 の `InferenceBackend` 抽象化と `browser-built-in-full-model` kind
  （将来のfull-model backend用の予約枠。実装なし）

### C. Swarm / ensemble experiments

軽量モデルを複数ノードで完全実行し、分散合意・アンサンブルを行う探索的トラックです。

- [`SWARM.md`](./SWARM.md)
- [`docs/strategy-ensemble-inference.md`](./docs/strategy-ensemble-inference.md)

## 3. 現在の成熟度

| 領域 | 実装されているもの | 現在の基本status |
|---|---|---|
| 基本Pipeline / SpanPipeline | Worker選択、segment実行、checkpoint、retryのTypeScript prototype | `contract-tested` |
| 2B / 2-worker milestone | mock segment artifactを使う比較・resume harness。**実ブラウザWebGPU単一ワーカー実行（Llama-3.2-1B q4）は実測済み（2026-08-06）** | `contract-tested` + 単一ワーカー実測（self-reported） |
| AdaptiveChunkDispatcher | telemetry fixtureからchunk length・score・assignmentを計算 | `contract-tested` |
| 30B WebGPU feasibility | model/runtime/checkpoint metadataの判定 + WebGPUデバイス前提の実測（Chrome 150 / Metal 3） | `contract-tested` + デバイス前提実測（self-reported） |
| checkpoint transfer | deterministic payloadのserializationとtransfer estimate | `contract-tested` |
| browser retention | session sampleからretention/retry影響を集計 | `contract-tested` |
| Coordinator prototype | API lifecycle、heartbeat、assignment、relayのsimulated report | `contract-tested` |
| Miniflare smoke | Miniflare/workerd上のfetch・storage・WebSocket境界 | `runtime-observed`（対象範囲限定） |
| deployed/browser/WebGPU系gate | evidence envelopeとdecision logicのvalidator | provenanceがなければ`contract-tested`。browser preview・pilot・telemetry gateはenvelope検証済みのみ受け付け |
| fleet SLO、reward、payout、tax | upstream reportからの判定・reconciliation logic | 主に`contract-tested` |

> 破棄済み: Chrome Built-in AI（#92/#93/#95/#100）は、特別な設定なしにはAPIが
> 露出しないことを実ブラウザ計測で確認したため採用を破棄（2026-08-06）。
> 関連コード削除済み。

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
| WorkerPool | `src/worker-pool.ts` | Worker登録・heartbeat・選択・状態管理 |
| CheckpointStore | `src/checkpoint.ts` | checkpointの保存・取得 |
| Pipeline | `src/pipeline.ts` | 1 segment / 1 Workerのpipeline |
| SpanRouter | `src/span-router.ts` | 連続segmentを一つのWorkerへ割り当てるroute計算 |
| SpanPipeline | `src/span-pipeline.ts` | span単位のpipeline実行 |
| Coordinator | `src/coordinator.ts` | request受付とpipeline統括 |
| Durable Coordinator | `src/durable-coordinator.ts` | durable state・idempotency・request identity・retry/cancellationを備えたCoordinator (#103) |
| Durable Repository | `src/durable-repository.ts` | storage境界を分けたrepository interface + in-memory実装 (#103) |
| Durable Object Repository | `src/durable-object-repository.ts` | SQLite-backed Durable Objectの同期KVへCoordinator stateを永続化するproduction adapter (#103) |
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
| Tax production exception operations | `src/workers-coordinator-publisher-tax-production-exception-operations.ts` | rejected/corrected/duplicate/replayからrunbook・support・publisher statusを照合 (#91) |
| Tax production exception resolution audit | `src/workers-coordinator-publisher-tax-production-exception-resolution-audit.ts` | resolved/carry-forward、correction outcome、support/publisher final status、identity integrityを照合 (#116) |
| Tax production exception archive / retention | `src/workers-coordinator-publisher-tax-production-exception-audit-archive-retention.ts` | versioned archive、SHA-256 digest、retrieval proof、retention/deletion reviewを照合 (#118) |
| Tax production exception archive restore / integrity drill | `src/workers-coordinator-publisher-tax-production-exception-archive-restore-drill.ts` | primary/backup restore、post-restore digest、integrity check、access audit、retention-state preservationを照合 (#121) |
| Tax production exception archive disaster recovery operations | `src/workers-coordinator-publisher-tax-production-exception-archive-disaster-recovery-operations.ts` | restore cadence、RTO/RPO、backup age/replication lag、incident escalation、provider evidence provenanceを照合 (#123) |
| Tax production exception archive DR provider pilot | `src/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-pilot.ts` | captured-and-verified provider artifact、primary/backup retrieval、scheduled restore、DR objectivesを照合 (#126) |
| Tax production exception archive DR provider production readiness | `src/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-production-readiness.ts` | recurring verified runs、production window、two-person approval、error budget、key rotation、failover exerciseを照合 (#128) |
| Tax production exception archive DR provider production cutover | `src/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-production-cutover.ts` | approved window内のlive provider operation、archive integrity、DR objectives、monitoring、rollback/hold controlsを照合 (#131) |

signed runnerのbrowser preview・WebGPU worker pilot・telemetry gateは、`EvidenceEnvelope`と`validateEvidenceEnvelope()`を経由してのみ証拠を受け付けます。手書きfixtureは`captured-and-verified`へ到達できず、`contract-tested`に留まります。

詳細:

- [`docs/workers-coordinator-prototype.md`](./docs/workers-coordinator-prototype.md)
- [`docs/publisher-tax-production-exception-operations.md`](./docs/publisher-tax-production-exception-operations.md)
- [`docs/publisher-tax-production-exception-resolution-audit.md`](./docs/publisher-tax-production-exception-resolution-audit.md)
- [`docs/publisher-tax-production-exception-audit-archive-retention.md`](./docs/publisher-tax-production-exception-audit-archive-retention.md)
- [`docs/publisher-tax-production-exception-archive-restore-drill.md`](./docs/publisher-tax-production-exception-archive-restore-drill.md)
- [`docs/publisher-tax-production-exception-archive-disaster-recovery-operations.md`](./docs/publisher-tax-production-exception-archive-disaster-recovery-operations.md)
- [`docs/publisher-tax-production-exception-archive-dr-provider-pilot.md`](./docs/publisher-tax-production-exception-archive-dr-provider-pilot.md)
- [`docs/publisher-tax-production-exception-archive-dr-provider-production-readiness.md`](./docs/publisher-tax-production-exception-archive-dr-provider-production-readiness.md)
- [`docs/publisher-tax-production-exception-archive-dr-provider-production-cutover.md`](./docs/publisher-tax-production-exception-archive-dr-provider-production-cutover.md)
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
npm run test:workers-publisher-tax-production-exceptions
npm run test:workers-publisher-tax-production-exception-resolution
npm run test:workers-publisher-tax-production-exception-archive
npm run test:workers-publisher-tax-production-exception-archive-restore
npm run test:workers-publisher-tax-production-exception-archive-dr
npm run test:workers-publisher-tax-production-exception-archive-dr-provider-pilot
npm run test:workers-publisher-tax-production-exception-archive-dr-provider-production-readiness
npm run test:workers-publisher-tax-production-exception-archive-dr-provider-production-cutover
npx vitest run tests/inference-backend.test.ts
npx vitest run tests/backend-registry.test.ts
npx vitest run tests/legacy-worker-adapter.test.ts
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

- [#131](https://github.com/azumag/unzen/issues/131): production exception archive DR provider production cutover — exact readiness run/window/change-ticket/approvalsへauthorizationを固定し、live provider operation、archive integrity、RTO/RPO、immediate monitoring、rollback/emergency-hold、identity preservationを照合。次の`publisher-tax-filing-production-exception-archive-dr-provider-post-cutover-reconciliation`をbottleneckとして明示
- [#128](https://github.com/azumag/unzen/issues/128): production exception archive DR provider production-readiness — 3本以上の独立verified run・2 restore windows、production restore window、two-person approval、monitoring/error budget、credential/key rotation、backup failover exerciseを照合し、`production-candidate`で停止。次の`publisher-tax-filing-production-exception-archive-dr-provider-production-cutover`をbottleneckとして明示
- [#126](https://github.com/azumag/unzen/issues/126): production exception archive DR provider pilot — self-reported provider metadataではなくcaptured-and-verified evidenceを必須化し、primary/backup retrieval、scheduled restore、RTO/RPO/freshness、provider/account/storage/replica identityを照合。次の`publisher-tax-filing-production-exception-archive-dr-provider-production-readiness`をbottleneckとして明示
- [#123](https://github.com/azumag/unzen/issues/123): production exception archive disaster recovery operations — restore cadence、RTO/RPO、backup age/replication lag、recovery ownership、incident escalation、archival-provider evidence provenanceを照合。次の`publisher-tax-filing-production-exception-archive-dr-provider-pilot`をbottleneckとして明示
- [#121](https://github.com/azumag/unzen/issues/121): production exception archive restore / integrity drill — primary/backupから同一archive identityを復元し、post-restore SHA-256 integrity check、backup recovery、access audit、retention/hold/deletion stateの不変性を検証。次の`publisher-tax-filing-production-exception-archive-disaster-recovery-operations`をbottleneckとして明示
- [#118](https://github.com/azumag/unzen/issues/118): production exception audit archive / retention — resolution audit identityをversioned archiveへ固定し、SHA-256 digest、archive/provider retrieval proof、minimum retention、carry-forward review、hold/deletion reviewを照合。次の`publisher-tax-filing-production-exception-archive-restore-drill`をbottleneckとして明示
- [#116](https://github.com/azumag/unzen/issues/116): production exception resolution audit — runbook actionをresolved/carry-forwardへ収束させ、corrected filing provider outcome、support resolution、publisher final status、immutable identity auditを照合。次の`publisher-tax-filing-production-exception-audit-archive-retention`をbottleneckとして明示
- [#91](https://github.com/azumag/unzen/issues/91): production monitoring後のexception operations runbook — rejected/corrected/duplicate-suppressed/replay-detected eventをoperator action、support escalation、publisher status、rollback/hold decisionへtraceし、次の`publisher-tax-filing-production-exception-resolution-audit`をbottleneckとして明示
- [#101](https://github.com/azumag/unzen/issues/101): simulated evidenceと実測evidenceの分離 — evidence envelope基盤(#108)とbrowser preview・WebGPU pilot・telemetry gateのenvelope検証移行で対応済み。残りは各gateの実証拠artifactの取得
- [#102](https://github.com/azumag/unzen/issues/102): hard-coded model geometryとplaceholder hashのmanifest化 — `SegmentedModelManifest` + 起動時fail-fast validatorで対応済み。30B/8segment/~2.1GBはEXAMPLE fixtureであり実測値ではない
- [#103](https://github.com/azumag/unzen/issues/103): durable request state、idempotency、retry、cancellation — `DurableCoordinator` + `DurableObjectRepository`でproduction storage境界まで実装。実deployed Durable Object evidenceは別途必要（詳細は[`docs/coordinator-durability.md`](./docs/coordinator-durability.md)）
- [#94](https://github.com/azumag/unzen/issues/94): InferenceBackend / `WorkerCapability`抽象化 — segmented・full-model・server-fallbackを同一capabilityでrouting（詳細は[`docs/inference-backend-abstraction.md`](./docs/inference-backend-abstraction.md)）
- [#92](https://github.com/azumag/unzen/issues/92) / [#93](https://github.com/azumag/unzen/issues/93) / [#95](https://github.com/azumag/unzen/issues/95) / [#100](https://github.com/azumag/unzen/issues/100): Chrome Built-in AI / Prompt API — **破棄**（特別な設定なしにはAPIが露出しないことを実ブラウザ計測で確認。関連コード削除済み）

contract gateが揃っていても、実provider・実tax filing・実browser artifactがcaptured-and-verifiedになるまではproduction-ready systemとは表現しません。

## 8. 既知の制約

- 30B、8 segment、約2.1GB/segment、約4秒/segment等は**仮定値を含むEXAMPLE**であり、実測値ではない。権威あるgeometryは`SegmentedModelManifest`が保持する
- `Coordinator`は検証済みの`SegmentedModelManifest`を注入され、起動時にplaceholder hash・fixture manifest・不整合geometryをrejectする（#102対応済み）
- `DurableCoordinator`は`DurableObjectRepository`によりSQLite-backed Durable Objectの同期KVへrequest/status/idempotency/lease/checkpoint/result等を永続化できる。実Cloudflare deploymentでのproduction evidenceはまだ取得していない
- 基本Pipelineのtimeoutは`withAbortableTimeout`（`src/pipeline-utils.ts`）でunderlying executionをabortする設計に移行済み（#103）
- 手書きfixture fieldだけでは実行証拠にならない。browser preview・WebGPU pilot・telemetry gateはevidence envelopeの検証を必須とし、`contract-tested`以上へは昇格しない
- Chrome Prompt API / Built-in AI は採用を破棄（#92/#93/#95/#100）。実ブラウザ計測で特別な設定なしにはAPIが露出しないことを確認（2026-08-06）。`browser-built-in-full-model` kindは#94抽象化としてのみ残存
- payout・tax gateは実providerの資金移動・申告完了を意味しない

## 9. 関連ドキュメント

| ドキュメント | 内容 | 状態 |
|---|---|---|
| [`PLAN.md`](./PLAN.md) | 確定方針とpipeline計画 | 設計基準。仮定値は実測値と区別する |
| [`docs/evidence-readiness.md`](./docs/evidence-readiness.md) | evidence levelとreadiness規約 | #108で導入、gate移行#101で適用 |
| [`docs/model-manifest.md`](./docs/model-manifest.md) | `SegmentedModelManifest` / validator | #102で導入 |
| [`docs/2b-two-worker-prototype.md`](./docs/2b-two-worker-prototype.md) | 2B / 2-worker milestone | contract harnessあり + 単一ワーカーWebGPU実測記録（2026-08-06） |
| [`docs/adaptive-chunk-dispatcher.md`](./docs/adaptive-chunk-dispatcher.md) | adaptive dispatcher | simulated logicあり |
| [`docs/webgpu-30b-partial-inference-feasibility.md`](./docs/webgpu-30b-partial-inference-feasibility.md) | 30B partial inferenceの判定項目 | metadata gateあり、実browser検証は別 |
| [`docs/checkpoint-transfer-measurement.md`](./docs/checkpoint-transfer-measurement.md) | checkpoint measurement | deterministic harnessあり |
| [`docs/browser-worker-retention-measurement.md`](./docs/browser-worker-retention-measurement.md) | retention measurement | sample aggregation harnessあり |
| [`docs/coordinator-prototype.md`](./docs/coordinator-prototype.md) | Coordinator prototype | simulated harnessあり |
| [`docs/coordinator-durability.md`](./docs/coordinator-durability.md) | Durable Coordinator (#103): durable state・idempotency・identity・retry/cancellation・checkpoint envelope | Durable Object production adapter実装済み、deployment evidenceは別 |
| [`docs/inference-backend-abstraction.md`](./docs/inference-backend-abstraction.md) | InferenceBackend / `WorkerCapability`抽象化 (#94): backend kind、capability validation、event union、capability routing、per-backend責任境界 | mock backend + routing unit testでcontract検証 |
| [`docs/workers-coordinator-prototype.md`](./docs/workers-coordinator-prototype.md) | Workers/operations gate chain | contractとruntime evidenceを区別して読む |
| [`docs/publisher-tax-production-exception-operations.md`](./docs/publisher-tax-production-exception-operations.md) | production monitoring後のexception runbook、support/publisher traceability、control decision、次bottleneck | #91 contract gate |
| [`docs/publisher-tax-production-exception-resolution-audit.md`](./docs/publisher-tax-production-exception-resolution-audit.md) | exception action resolution、correction outcome、support/publisher final status、identity integrity、次bottleneck | #116 contract gate |
| [`docs/publisher-tax-production-exception-audit-archive-retention.md`](./docs/publisher-tax-production-exception-audit-archive-retention.md) | resolution audit archive、SHA-256 integrity、retrieval、retention/hold/deletion review、次bottleneck | #118 contract gate |
| [`docs/publisher-tax-production-exception-archive-restore-drill.md`](./docs/publisher-tax-production-exception-archive-restore-drill.md) | primary/backup restore、post-restore digest、integrity check、access audit、retention-state preservation、次bottleneck | #121 contract gate |
| [`docs/publisher-tax-production-exception-archive-disaster-recovery-operations.md`](./docs/publisher-tax-production-exception-archive-disaster-recovery-operations.md) | recurring DR cadence、RTO/RPO、backup freshness、incident escalation、provider provenance、次bottleneck | #123 contract gate |
| [`docs/publisher-tax-production-exception-archive-dr-provider-pilot.md`](./docs/publisher-tax-production-exception-archive-dr-provider-pilot.md) | captured-and-verified provider pilot、primary/backup retrieval、scheduled restore、DR objective再検証、次bottleneck | #126 verified-pilot gate |
| [`docs/publisher-tax-production-exception-archive-dr-provider-production-readiness.md`](./docs/publisher-tax-production-exception-archive-dr-provider-production-readiness.md) | recurring verified provider runs、production restore window、two-person approval、error budget、credential/key rotation、backup failover exercise、次bottleneck | #128 production-candidate gate |
| [`docs/publisher-tax-production-exception-archive-dr-provider-production-cutover.md`](./docs/publisher-tax-production-exception-archive-dr-provider-production-cutover.md) | bounded production cutover authorization、live provider operation、archive integrity、DR objectives、monitoring、rollback/hold controls、次bottleneck | #131 production-approved evidence gate |
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
