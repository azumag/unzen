# Evidence level と production readiness の運用規約

この文書は、`LLM-proto` のテスト、harness、report gate、運用判断で使う証拠レベルを定義する。

## 背景

`LLM-proto` には、制御フローや判定ロジックを固定するための多数のTypeScript harnessがある。これらは設計を実行可能な形にするうえで有用だが、呼び出し側が構築したobject fixtureを入力としているものも多い。

fixtureに `source: "real-browser-webgpu-worker-pilot"`、`state: "completed"`、provider callback ID等を書けることは、その実行や外部イベントが現実に発生した証明にはならない。

したがって、以下を明確に分離する。

- contract・schema・decision logicが正しいこと
- 特定runtimeで処理が実行されたこと
- 保存されたartifactが第三者またはCI/operatorにより検証されたこと
- productionへ進める運用判断

## Evidence level

### Level 1: `synthetic-fixture`

手書きfixture、mock、simulator、deterministic payloadを利用した検証。

用途:

- 型、schema、validator
- state transition
- routing、retry、fallbackの判定
- security policyのdecision logic
- report format
- failure reason、threshold、promote/hold/rollbackロジック

証明しないもの:

- 実ブラウザで動いたこと
- WebGPUまたはPrompt APIが動いたこと
- 実Coordinator、CDN、Durable Objectへ接続したこと
- 外部providerからcallbackを受けたこと
- 資金移動、税務申告、利用者への文書配布が行われたこと

通常のunit test成功はこのlevelである。

### Level 2: `self-reported-runtime`

対象runtime自身が生成したreport。runtime上での実行を示す情報はあるが、artifactの保存、digest、独立したverification、freshness保証が不足している状態。

必要項目:

- schema version
- producer name / version
- run ID
- captured timestamp
- environment metadata
- execution surface
- runtime result
- redaction state

用途:

- local manual validation
- 開発中のbrowser integration
- operatorが次の調査へ進むための診断

production readinessの単独根拠にはしない。

### Level 3: `captured-and-verified`

実行artifactが保存され、provenanceとintegrityが検証された証拠。

必須項目:

- evidence kind / schema version
- producer name / version / commit SHA
- run ID
- captured timestamp
- Chrome・OS・runtime・execution surface等のenvironment metadata
- artifact locator
- artifact SHA-256 digest
- verifier name / version
- verification timestamp / result
- freshnessまたはexpiration
- redaction status
- 対象feature、scenario、expected result

用途:

- compatibility matrixの「確認済み」判定
- canary promote / hold / rollback
- SLO、性能、失敗率の判断
- 実provider sandbox・production callbackの確認
- production readiness review

## Readiness status

Evidence levelとは別に、機能の成熟度を以下で表す。

| Status | 意味 |
|---|---|
| `design-only` | 文書・interface・未実行仕様のみ |
| `contract-tested` | Level 1でschema・decision logic・制御フローを確認 |
| `runtime-observed` | Level 2のruntime reportあり |
| `verified-pilot` | 対象scenarioのLevel 3 evidenceあり |
| `production-candidate` | 必須scenario、SLO、security、rollback条件をLevel 3で満たす |
| `production-approved` | 運用者による明示承認、監視、runbook、kill switchを含めて承認済み |

`pass`というreport fieldだけでreadiness statusを昇格させてはならない。

## 現行実装の読み方

2026年7月時点の原則的な分類を示す。個々のartifactが追加された場合は、そのartifactのprovenanceに基づいて更新する。

| 領域 | 現在の主な証拠 | 基本status |
|---|---|---|
| 2B / 2-worker runner | mock segment artifactとallowlist transport | `contract-tested` |
| AdaptiveChunkDispatcher | telemetry fixtureによるscore・assignment | `contract-tested` |
| 30B WebGPU feasibility | manifestとruntime capabilityのmetadata評価 | `contract-tested` |
| checkpoint transfer | deterministic payloadと転送estimate | `contract-tested` |
| browser retention | session duration sample入力による集計 | `contract-tested` |
| Coordinator prototype | simulated worker / checkpoint / heartbeat | `contract-tested` |
| Miniflare smoke | workerd/Miniflare runtime | `runtime-observed`。対象範囲を明記する |
| deployed smoke / browser preview | browser evidence envelopeをvalidatorで検証 | artifact provenanceがない場合は`contract-tested`。loader・verifier・trust listが揃ったLevel 3のみ`verified-pilot`以上 |
| signed runner WebGPU pilot / telemetry | caller supplied evidence envelopeをvalidatorで検証し、upstream readinessでcap | 現状は`contract-tested`。名称だけで実WebGPU実行済みとしない |
| fleet SLO / reward / payout / tax gates | upstream reportを入力するdecision gate | 主に`contract-tested`。実fleet・資金移動・申告を証明しない |

> 破棄済み: Chrome Built-in AI (issues #92/#93/#95/#100) は、特別な設定なしには
> API が露出しないことが実ブラウザ計測で確認されたため採用を破棄しました。
> 関連コードは削除済みで、`browser-built-in-full-model` kind は #94 の
> 抽象化としてのみ残ります。

## 文書で使う表現

### 使用してよい表現

- 「contract testで判定ロジックを確認した」
- 「fixtureを入力したsimulated report」
- 「Miniflare runtimeで対象endpointをsmoke testした」
- 「実ブラウザartifactは未取得」
- 「Level 3 evidence取得後にproduction判断する」

### Evidenceなしで使用しない表現

- 「実WebGPU Workerで検証済み」
- 「production ready」
- 「実決済済み」「申告済み」
- 「全ブラウザ対応」
- 「実測値」
- 「安全であることを証明した」

対象を限定し、どのenvironment、scenario、evidence levelで確認したかを併記する場合のみ使用できる。

## Gate実装規則

1. reportは`status: pass | fail`だけでなく、`evidenceLevel`と`readinessStatus`を持つ
2. synthetic fixtureからLevel 3へ昇格できない
3. downstream gateはupstream evidence levelを保持する
4. Level 1を入力したfleet・settlement・tax gateは、decision logicの結果のみを表す
5. digest不一致、schema不一致、期限切れ、verifier不明のartifactはLevel 3として扱わない
6. `real`、`verified`、`production`をtype名・script名・見出しに使う場合、必要条件を文書化する
7. production判断にはnegative scenario、rollback、kill switchの証拠も必要とする

## Artifact envelope案

```ts
interface EvidenceEnvelope<T> {
  schemaVersion: string;
  evidenceLevel:
    | 'synthetic-fixture'
    | 'self-reported-runtime'
    | 'captured-and-verified';
  readinessStatus:
    | 'design-only'
    | 'contract-tested'
    | 'runtime-observed'
    | 'verified-pilot'
    | 'production-candidate'
    | 'production-approved';
  producer: {
    name: string;
    version: string;
    commitSha?: string;
  };
  runId: string;
  capturedAt: string;
  environment: Record<string, string>;
  artifact?: {
    locator: string;
    sha256: string;
    expiresAt?: string;
  };
  verification?: {
    verifier: string;
    version: string;
    verifiedAt: string;
    result: 'pass' | 'fail';
  };
  redaction: {
    applied: boolean;
    policyVersion: string;
  };
  payload: T;
}
```

最終schemaとmigrationはIssue #101で実装する。

## PR・Issueの完了条件

実装Issueで「検証済み」を完了条件とする場合、次を明記する。

- 必要なevidence level
- 対象environment
- positive / negative scenario
- artifact保存先
- verifier
- freshness
- failure時のIssue化・rollback条件

## 関連Issue

- [#92 Chrome Built-in AIをUnzen Workerとして利用する](https://github.com/azumag/unzen/issues/92) — **破棄**（特別な設定なしにはAPIが露出しないため）
- [#93 Chrome Prompt APIの実ブラウザfeasibility harness](https://github.com/azumag/unzen/issues/93) — **破棄**（#92と同理由。関連コード削除済み）
- [#95 ChromeLanguageModelBackend 実装](https://github.com/azumag/unzen/issues/95) — **破棄**（#92と同理由。revert済み）
- [#100 Chrome backend E2E・互換性matrix・段階的rollout](https://github.com/azumag/unzen/issues/100) — **破棄**（#92/#93に依存）
- [#101 simulated evidenceと実測evidenceを分離](https://github.com/azumag/unzen/issues/101)
- [#102 model geometry・placeholder hashをmanifestへ移行](https://github.com/azumag/unzen/issues/102)
- [#103 Coordinatorの永続性・retry/cancellation semantics](https://github.com/azumag/unzen/issues/103)
