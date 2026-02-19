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
| プロトコル | `src/protocol.ts` | Coordinator-Worker 間の WebSocket メッセージ定義 |
| CheckpointStore | `src/checkpoint.ts` | セグメント間の中間状態（hidden states）を保存・取得 |
| WorkerPool | `src/worker-pool.ts` | ブラウザワーカーのTier別管理・選択・死活監視 |
| Pipeline | `src/pipeline.ts` | 推論リクエストを N セグメントに分割しチェックポイント・リジュームで実行 |
| Coordinator | `src/coordinator.ts` | API受付・ワーカー管理・パイプライン実行を統括 |

### アーキテクチャ

```
API顧客 → Coordinator → [Seg0] → checkpoint → [Seg1] → ... → [Seg7] → 結果
               ↕ WebSocket                ↕
          WorkerPool (Tier 1/2/3)    CheckpointStore
```

- **Tier 1**: 24h稼働デバイス（サイネージ等） — 最優先
- **Tier 2**: 長時間ワーカー（OBS、拡張機能、Electron） — 高優先
- **Tier 3**: 通常Web訪問者 — バースト対応

### テスト実行

```bash
cd LLM-proto
npm install
npm test
```

## 関連ドキュメント

| ドキュメント | 内容 | ステータス |
|---|---|---|
| [PLAN.md](./PLAN.md) | 計画書 v2.6（確定方針） | **確定** |
| [docs/strategy-ensemble-inference.md](./docs/strategy-ensemble-inference.md) | 並列アンサンブル推論戦略案 | 検討中 |
| [docs/archive/](./docs/archive/ARCHIVE_INDEX.md) | 廃止ドキュメント一覧 | アーカイブ |
