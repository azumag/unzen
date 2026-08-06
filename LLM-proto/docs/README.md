# LLM-proto documents

## 最初に読む文書

1. [`../README.md`](../README.md) — 実装トラックと現在の成熟度
2. [`evidence-readiness.md`](./evidence-readiness.md) — evidence levelとproduction readinessの規約
3. [`evidence-validation.md`](./evidence-validation.md) — TypeScript validator、trust boundary、利用方法
4. [`documentation-status.md`](./documentation-status.md) — 文書更新時の整合性チェックリスト
5. [`../PLAN.md`](../PLAN.md) — 確定方針と技術計画
6. [`workers-coordinator-prototype.md`](./workers-coordinator-prototype.md) — Coordinator・operations gate chainの詳細
7. [`inference-backend-abstraction.md`](./inference-backend-abstraction.md) — InferenceBackend / `WorkerCapability`抽象化（#94）とper-backend責任境界
8. [`../browser-harness/webgpu-2b/`](../browser-harness/webgpu-2b/) — WebGPU 実測harness（transformers.js + WebGPU でモデル実行・計測）

## 読み方

ファイル名、type名、script名に`real`または`production`が含まれていても、それだけで実環境検証済みとは判断しません。各reportの入力evidence、artifact provenance、environment、verification stateを確認してください。

- mock・fixture・simulator: contract test
- runtime自身のreport: runtime observation
- digestとverifierを持つartifact: verified evidence

最新の実装計画は[`../PLAN.md`](../PLAN.md)、証拠モデルの是正はIssue #101を参照してください。

> 注: Chrome Prompt API / Built-in AI 採用方針（#92/#93/#95/#100）は、実ブラウザ計測で特別な設定なしには API が露出しないことが確認されたため破棄しました（#95 revert・関連ファイル削除済み）。`browser-built-in-full-model` kind は抽象化としてのみ残ります。
