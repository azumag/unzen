# Unzen — ブラウザ分散コンピューティング実験プロジェクト

Webブラウザやクライアント端末の余剰計算資源を活用し、中央集権型クラウドとは異なる計算基盤を検証する実験プロジェクトです。

> [!IMPORTANT]
> 現在は設計、制御フロー、セキュリティ境界、運用ゲートのプロトタイプが中心です。テストが通ることと、実ブラウザ・実モデル・実決済等で本番運用可能であることは同義ではありません。

## 現在の実装トラック

| トラック | 目的 | 現在の状態 |
|---|---|---|
| [`core`](./core/) | QuickJS/Wasmを利用したブラウザ委譲型の汎用コード実行 | ブラウザ実行・サーバーフォールバックのプロトタイプとE2Eデモあり |
| [`LLM-proto`](./LLM-proto/) — segmented WebGPU | モデルをセグメント分割し、Coordinator経由のcheckpoint relayで推論する方式 | TypeScriptの制御フロー、metadata、Miniflare smoke、各種gateを実装中。実モデル・実ブラウザ証拠は別途検証が必要 |
| [`LLM-proto`](./LLM-proto/) — Chrome Built-in AI | Chromeが管理する端末内モデルをfull-model Workerとして利用する方式 | Issue #92配下でfeasibility・Backend抽象化・UI/UX・E2Eを設計中 |
| [`LLM-proto/SWARM.md`](./LLM-proto/SWARM.md) | 軽量モデルを複数ノードで実行し、分散合意する実験方式 | 探索的・実験的 |

## Evidenceとreadiness

このリポジトリでは、今後の文書とreportで証拠レベルを区別します。

1. **synthetic fixture / contract test** — 手書きfixtureやmockでschema・判定ロジック・制御フローを確認
2. **self-reported runtime evidence** — 実行環境自身が生成したreport。外部検証やartifact provenanceは未確立
3. **captured and verified evidence** — environment metadata、artifact、digest、verifier、freshnessを伴う検証済み証拠

本番readiness、SLO、精算・支払等の判断根拠には、原則として3が必要です。詳細は [`LLM-proto/docs/evidence-readiness.md`](./LLM-proto/docs/evidence-readiness.md) を参照してください。

## 共通方針

### ブラウザを実行環境として利用

- WebGPU、WebAssembly、Web Worker等を用途に応じて利用する
- ユーザーの明示的なオプトインを前提とする
- リソース使用量、準備状態、停止方法を利用者へ表示する
- 非対応環境や処理失敗時には安全なフォールバックを用意する

### 通信とセキュリティ境界

LLMパイプラインではWorker同士の任意な直接通信を許可せず、CoordinatorとUnzen管理CDNを通信境界とします。sandbox iframe、CSP、COOP/COEP、署名検証等の設計はありますが、各境界が実ブラウザで検証済みかはevidence levelと併記します。

### 報酬と運用

LLMトラックではWorker・サイト運営者への報酬が必要という方針です。精算、支払、税務関連の実装は現時点では主にcontract/report gateであり、実際のprovider・資金移動・法令対応が完了したことを意味しません。

## プロジェクト構成

```text
.
├── core/                       # ブラウザ委譲型の汎用コード実行
│   ├── README.md
│   ├── docs/
│   ├── packages/
│   ├── demo/
│   └── examples/
└── LLM-proto/                  # 分散型LLM推論の設計・プロトタイプ
    ├── README.md               # 実装概要と現在の成熟度
    ├── PLAN.md                 # 計画書 v2.6
    ├── SWARM.md                # 群知能方式
    ├── docs/
    ├── src/
    └── tests/
```

## 主要Issue

- [#92 Chrome Built-in AI（Prompt API / Gemini Nano）をUnzen Workerとして利用する](https://github.com/azumag/unzen/issues/92)
- [#101 simulated evidenceと実測evidenceを分離しreadiness表現を是正](https://github.com/azumag/unzen/issues/101)
- [#102 hard-coded model geometry・placeholder hashをmodel manifestに置換](https://github.com/azumag/unzen/issues/102)
- [#103 Coordinatorの永続性・request identity・retry/cancellation semanticsを修正](https://github.com/azumag/unzen/issues/103)
- [#104 core E2E demoのUI/UXを改善](https://github.com/azumag/unzen/issues/104)

## 現時点で保証しないもの

- 商用SLA、可用性、性能、費用優位性
- 30Bモデルの実ブラウザ分割推論が成立すること
- READMEに記載された仮定値が実測値であること
- Chrome Built-in AIが全Chrome環境で利用できること
- payout・税務gateが実際の資金移動や申告完了を証明すること

各トラックは、実測artifactと再現可能な手順が揃った段階で成熟度表示を更新します。
