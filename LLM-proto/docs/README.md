# LLM-proto documents

## 最初に読む文書

1. [`../README.md`](../README.md) — 実装トラックと現在の成熟度
2. [`real-two-segment-webgpu-e2e.md`](./real-two-segment-webgpu-e2e.md) — **現在のP0 (#165)**。約200MiB/workerを目標に、SmolLM2-135M q4でsame-machine logits比較→2 browser WebGPU→checkpoint resumeまで確認する手順
3. [`evidence-readiness.md`](./evidence-readiness.md) — evidence levelとproduction readinessの規約
4. [`evidence-validation.md`](./evidence-validation.md) — TypeScript validator、trust boundary、利用方法
5. [`documentation-status.md`](./documentation-status.md) — 文書更新時の整合性チェックリスト
6. [`endpoint-layout-candidate-probe.md`](./endpoint-layout-candidate-probe.md) — #223 の方式決定前に4/5/8 physical payloadと8-way execution viewを比較し、CPU ORTのcomplete post-stage equivalence、4/5-way primitive、4-way preferred payloadを逐次処理するcomplete final-norm + tiled-lm-headの実Chrome/Apple Metal ORT WebGPU実行、およびisolated Chrome process-RSS envelope、document teardown後のbaseline回復、およびmacOS physical-footprintのmilestone観測を検証するdiagnostic-only probe
7. [`miniflare-multi-service-test-isolation.md`](./miniflare-multi-service-test-isolation.md) — #261 の重いMiniflare multi-service smokeを通常suite後に直列実行するテスト分離方針
8. [`../PLAN.md`](../PLAN.md) — 確定方針と技術計画
9. [`workers-coordinator-prototype.md`](./workers-coordinator-prototype.md) — Coordinator・operations gate chainの詳細
10. [`inference-backend-abstraction.md`](./inference-backend-abstraction.md) — InferenceBackend / `WorkerCapability`抽象化（#94）とper-backend責任境界
11. [`../browser-harness/webgpu-2b/`](../browser-harness/webgpu-2b/) — 単一ブラウザWebGPU 実測harness（transformers.js + WebGPU）
12. [`../browser-harness/webgpu-2b-split/`](../browser-harness/webgpu-2b-split/) — #165 の2ブラウザ実segment relay harness（ディレクトリ名はhistorical）

## 設計判断

- [`cloudflare-wasm-adoption-decision.md`](./cloudflare-wasm-adoption-decision.md) — #301/#312 のCloudflare Workers Wasm採否。現時点は **limited-adoption** で、small pure deterministic kernelのみ条件付き許可し、production validator/Coordinator置換と性能根拠なしの移行は禁止

## 読み方

ファイル名、type名、script名に`real`または`production`が含まれていても、それだけで実環境検証済みとは判断しません。各reportの入力evidence、artifact provenance、environment、verification stateを確認してください。

- mock・fixture・simulator: contract test
- runtime自身のreport: runtime observation
- digestとverifierを持つartifact: verified evidence

現在は #165 の browser-budgeted real segmented / two-browser WebGPU E2E を技術的核心のP0として扱い、Continuous Assurance production deployment #158 はその実測成立までHOLDです。P0成立後の1B scale-upでもartifact target約200MiB / preferred<=256MiB / hard<=1GiBを維持し、必要segment数を増やします。

最新の実装計画は[`../PLAN.md`](../PLAN.md)、証拠モデルの是正はIssue #101を参照してください。

> 注: Chrome Prompt API / Built-in AI 採用方針（#92/#93/#95/#100）は、実ブラウザ計測で特別な設定なしには API が露出しないことが確認されたため破棄しました（#95 revert・関連ファイル削除済み）。`browser-built-in-full-model` kind は抽象化としてのみ残ります。
