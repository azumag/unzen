# LLM-proto documents

## 最初に読む文書

1. [`../README.md`](../README.md) — 実装トラックと現在の成熟度
2. [`evidence-readiness.md`](./evidence-readiness.md) — evidence levelとproduction readinessの規約
3. [`evidence-validation.md`](./evidence-validation.md) — TypeScript validator、trust boundary、利用方法
4. [`documentation-status.md`](./documentation-status.md) — 文書更新時の整合性チェックリスト
5. [`../PLAN.md`](../PLAN.md) — 確定方針と技術計画
6. [`workers-coordinator-prototype.md`](./workers-coordinator-prototype.md) — Coordinator・operations gate chainの詳細

## 読み方

ファイル名、type名、script名に`real`または`production`が含まれていても、それだけで実環境検証済みとは判断しません。各reportの入力evidence、artifact provenance、environment、verification stateを確認してください。

- mock・fixture・simulator: contract test
- runtime自身のreport: runtime observation
- digestとverifierを持つartifact: verified evidence

最新の実装計画はGitHub Issue #92、証拠モデルの是正はIssue #101を参照してください。
