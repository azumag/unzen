# LLM-proto documents

## 最初に読む文書

1. [`../README.md`](../README.md) — 実装トラックと現在の成熟度
2. [`real-two-segment-webgpu-e2e.md`](./real-two-segment-webgpu-e2e.md) — **現在のP0 (#165)**。実Llama q4を2 segmentへ分割し、same-machine logits比較→2 browser WebGPU→checkpoint resumeまで確認する手順
3. [`evidence-readiness.md`](./evidence-readiness.md) — evidence levelとproduction readinessの規約
4. [`evidence-validation.md`](./evidence-validation.md) — TypeScript validator、trust boundary、利用方法
5. [`documentation-status.md`](./documentation-status.md) — 文書更新時の整合性チェックリスト
6. [`../PLAN.md`](../PLAN.md) — 確定方針と技術計画
7. [`workers-coordinator-prototype.md`](./workers-coordinator-prototype.md) — Coordinator・operations gate chainの詳細
8. [`inference-backend-abstraction.md`](./inference-backend-abstraction.md) — InferenceBackend / `WorkerCapability`抽象化（#94）とper-backend責任境界
9. [`../browser-harness/webgpu-2b/`](../browser-harness/webgpu-2b/) — 単一ブラウザWebGPU 実測harness（transformers.js + WebGPU）
10. [`../browser-harness/webgpu-2b-split/`](../browser-harness/webgpu-2b-split/) — #165 の2ブラウザ実segment relay harness

## 読み方

ファイル名、type名、script名に`real`または`production`が含まれていても、それだけで実環境検証済みとは判断しません。各reportの入力evidence、artifact provenance、environment、verification stateを確認してください。

- mock・fixture・simulator: contract test
- runtime自身のreport: runtime observation
- digestとverifierを持つartifact: verified evidence

現在は #165 の real two-segment / two-browser WebGPU E2E を技術的核心のP0として扱い、Continuous Assurance production deployment #158 はその実測成立までHOLDです。

最新の実装計画は[`../PLAN.md`](../PLAN.md)、証拠モデルの是正はIssue #101を参照してください。

> 注: Chrome Prompt API / Built-in AI 採用方針（#92/#93/#95/#100）は、実ブラウザ計測で特別な設定なしには API が露出しないことが確認されたため破棄しました（#95 revert・関連ファイル削除済み）。`browser-built-in-full-model` kind は抽象化としてのみ残ります。
