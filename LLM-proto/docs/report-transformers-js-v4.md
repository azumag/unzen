# 調査レポート: Transformers.js v4 の unzen-LLM への適用可能性

## ステータス: 調査完了

**作成日**: 2026-02-16
**対象**: Hugging Face Transformers.js v4 (Preview)
**目的**: unzen-LLM プロジェクトへの採用可否判断

---

## 1. 対象

本レポートでは **Transformers.js v4** (Hugging Face、2026年2月9日Preview公開) を評価する。Python版 `transformers` ライブラリ (v4→v5移行済み) はブラウザ推論に無関係のため対象外。「Transformer v4」という名称のアーキテクチャ提案は存在しない。

---

## 2. Transformers.js v4 の概要

### 2.1 基本情報

| 項目 | 値 |
|---|---|
| パッケージ名 | `@huggingface/transformers` |
| インストール | `npm i @huggingface/transformers@next` (Preview) |
| ビルドシステム | esbuild (Webpackから移行、ビルド時間200ms) |
| バンドルサイズ | v3比で平均10%削減（Webビルドは最大53%削減） |
| 推論エンジン | ONNX Runtime Web |
| 対応モデル | 500+ (Hugging Face Hub上。LLM以外の汎用モデル含む) |
| リポジトリ | pnpmモノレポ構成 |
| ステータス | **Preview** (`next` タグで公開、安定版ではない) |

### 2.2 v4の主要な技術革新

1. **WebGPU ランタイムのC++完全書き直し**: ONNX Runtimeチーム（Microsoft）と共同開発。約200アーキテクチャでテスト済み
2. **3x-10x の速度向上**: WASM比でWebGPU使用時
3. **8B超モデルのサポート**: GPT-OSS 20B (q4f16) がM4 Pro Maxで約60 tokens/sec（ハイエンド端末での値。一般的な訪問者端末ではこれより大幅に低い）
4. **新アーキテクチャ対応**: Mamba (状態空間モデル)、MLA、MoE
5. **WebGPUブラウザカバレッジ**: デスクトップで約85%、モバイル含むグローバルトラフィックでは約70-75%
6. **クロス環境サポート**: ブラウザ、Node.js、Deno、Bun、Electronで同一コードが動作（PLAN.md 4.5項の長時間ワーカー戦略と親和性が高い）

### 2.3 量子化サポート

| dtype | 説明 | WebGPU対応 |
|---|---|---|
| `fp32` | 全精度 | ○ |
| `fp16` | 半精度 | ○ |
| `q8` / `int8` | 8-bit量子化 | ○ |
| `q4` | 4-bit量子化 | ○ |
| `q4f16` | 4-bit重み + 16-bit演算 | ○ |
| `bnb4` | BitsAndBytes 4-bit | ○ |
| 2-bit | 未対応 | ✕ |

### 2.4 メモリ制約

| 制約 | 上限 | 詳細 |
|---|---|---|
| ONNX Protobuf | 2 GB | 外部データファイルで回避可能 |
| WebAssembly メモリ | 4 GB | 32-bitアドレッシングの限界 |
| ブラウザ ArrayBuffer | ~2 GB (Chrome) | Firefox 64-bitでは8GBまで可能。ORT WebはWebAssembly.Memory()で回避 |
| 実用上のブラウザ限界 | 4-6 GB | これ以上はクラッシュリスク |
| Metal バッファ | デバイス依存 | MTLDevice.maxBufferLengthで取得。最新デバイスは~1GB以上 |

---

## 3. unzen-LLM 要件との適合性分析

### 3.1 PLAN.md パイプライン分割方式 (v2.6) との適合

PLAN.mdが要求する機能とTransformers.js v4の対応状況:

| 要件 | Transformers.js v4 | 判定 |
|---|---|---|
| WebGPUによるブラウザ推論 | ○ 完全対応 | ✓ |
| 4-bit量子化 | ○ q4, q4f16対応 | ✓ |
| Web Worker内での実行 | ○ WASM proxyモードあり | ✓ |
| IndexedDBキャッシュ | ○ ブラウザCache API対応 | ✓ |
| **モデルのレイヤー分割** | △ ネイティブAPI未提供 | **✗ 実用困難** |
| **部分レイヤーの単独実行** | △ ネイティブAPI未提供 | **✗ 実用困難** |
| **パイプライン並列** | ✕ 未対応 | **✗ 実用困難** |
| **チェックポイント中間状態取得** | △ ORT側で理論上可能 | **✗ 実用困難** |
| 2-bit量子化 | ✕ 最小4-bit | △ |
| 30Bモデル全体のロード | ✕ メモリ上限4-6GB | ✗ |

**不適合の理由**: Transformers.js v4自体にはレイヤー分割・部分実行のAPIが存在しない。ただし、基盤であるONNXエコシステムには`onnx.utils.extract_model`やonnx-graphsurgeon等のグラフ分割ツールが存在し、ONNXモデルをレイヤー境界で分割して個別の`InferenceSession`として実行することは理論上可能である。また、ONNX Runtime Webの`preferredOutputLocation: 'gpu-buffer'`を使えばGPU上の中間テンソルをセッション間で受け渡すこともできる。

しかし、これらは大規模なカスタム実装を要し、Transformers.js v4の高レベルAPIでは隠蔽されている。PLAN.md 5.2項のチェックポイント・リジューム方式をTransformers.js v4上で実現するには、ONNXレベルのモデル分割パイプラインをゼロから構築する必要があり、MVP段階では非現実的である。

### 3.2 アンサンブル推論方式 (strategy-ensemble-inference.md) との適合

アンサンブル方式では、各ノードが独立に完全なモデル推論を行うため、要件が異なる:

| 要件 | Transformers.js v4 | 判定 |
|---|---|---|
| 7B-8Bモデルの独立推論 | ○ 8B超モデル実証済み | ✓ |
| 4-bit量子化 (~3.5GB VRAM) | ○ q4対応 | ✓ |
| 複数ノードの独立並列実行 | ○ 各ブラウザが独立 | ✓ |
| WebGPU推論 | ○ 完全対応 | ✓ |
| ストリーミングトークン生成 | ○ TextStreamer対応 | ✓ |
| 異種モデル (Qwen/Llama/Gemma等) | ○ 約200アーキテクチャ対応 | ✓ |
| PairRM (0.4B) の実行 | △ DeBERTa系対応（PairRM自体のONNX変換・動作は要検証） | ✓ (要検証) |
| ノード間依存なし | ○ 各ノード完全独立 | ✓ |

**アンサンブル方式との適合性は極めて高い。**

---

## 4. WebLLM (MLC AI) との比較

PLAN.md 5.6項で言及されているWebLLM (MLC AI)との比較:

| 側面 | Transformers.js v4 | WebLLM (MLC AI) |
|---|---|---|
| 推論エンジン | ONNX Runtime Web | TVM (Apache TVM) |
| モデル形式 | ONNX | TVM compiled (MLC形式) |
| WebGPU活用 | JSEP経由のWGSLシェーダー | TVM生成のWGSLカーネル |
| テキスト生成特化 | 汎用 (NLP/Vision/Audio) | LLMテキスト生成特化 |
| モデル数 | 500+汎用 | LLM中心に限定的 |
| レイヤー分割可能性 | ネイティブ未対応（ONNXグラフ分割ツールで理論上可能） | ネイティブ未対応（TVMの中間表現操作で理論上可能） |
| エコシステム | Hugging Face Hub統合 | 独自Hubと変換パイプライン |
| 成熟度 | 高 (v4はPreviewだが基盤は安定) | 中 (活発に開発中) |
| コミュニティ | 非常に大きい | 中程度 |

**パイプライン分割方式を採用する場合**: いずれのツールもレイヤー分割APIを提供しておらず、大規模なカスタム実装が必要。ONNXにはグラフ分割ツール群が存在し、TVMにも中間表現操作の余地があるが、ブラウザ間パイプライン並列を実証した例はどちらにもない。

**アンサンブル方式を採用する場合**: Transformers.js v4の方がモデルの多様性、エコシステム統合、汎用性で優位。

---

## 5. 結論と推奨

### 5.1 パイプライン分割方式 (PLAN.md現行) への適用

**判定: 実用困難（MVPには不適合）**

Transformers.js v4自体にはレイヤー分割・パイプライン並列のAPIが存在しない。基盤のONNXエコシステムにはグラフ分割ツールが存在するため原理的には不可能ではないが、ブラウザ間パイプライン並列をゼロから構築する必要があり、MVP段階での採用は非現実的である。

### 5.2 アンサンブル推論方式への適用

**判定: 有力候補**

strategy-ensemble-inference.mdのアンサンブル方式（各ブラウザが7B-8Bモデルを独立実行、MoA/Best-of-Nで品質向上）には極めて適合する。

具体的な利点:
- 8B超モデルのブラウザ推論が実証済み
- 4-bit量子化でVRAM 3.5GBに収まる
- Hugging Face Hub上に多数のONNX変換済みモデルが利用可能
- ブラウザ・Node.js・Electron等で同一コードが動作（PLAN.md 4.5項の長時間ワーカー戦略と親和性が高い）
- Hugging Face Hubとの統合でモデル管理が容易

懸念点:
- **Preview段階**: APIが安定版リリース前に変更される可能性がある（モデルローディングAPI、dtypeオプション、WebGPUバックエンドAPI等）
- **ONNX変換の必要性**: 全モデルをONNX形式に変換する必要がある
- **初回推論のオーバーヘッド**: WebGPUシェーダーコンパイルに時間がかかる
- **ONNX Runtime Webへの強い依存**: Microsoft側の実装に品質が依存する

### 5.3 推奨アクション

1. **アンサンブル方式の技術検証をTransformers.js v4で実施する**: strategy-ensemble-inference.md 6項のステップ1（7Bモデルのブラウザ推論ベンチマーク）をTransformers.js v4とWebLLMの両方で実施し、速度・VRAM使用量・安定性を比較する
2. **パイプライン分割方式のMVPにはTransformers.js v4を採用しない**: ネイティブAPIが未提供であり、ONNXレベルのカスタム実装コストがMVP段階では非現実的なため
3. **安定版リリースを待つ**: 本番採用はPreviewからの安定版移行後が望ましい

---

**作成日**: 2026-02-16
**ステータス**: 調査完了
**関連文書**:
- [PLAN.md](../PLAN.md) — 計画書 v2.6（確定方針）
- [strategy-ensemble-inference.md](./strategy-ensemble-inference.md) — 並列アンサンブル推論戦略案

**調査ソース**:
- [Transformers.js v4 Preview: Now Available on NPM!](https://huggingface.co/blog/transformersjs-v4)
- [Transformers.js Documentation](https://huggingface.co/docs/transformers.js/en/index)
- [Transformers.js GitHub Repository](https://github.com/huggingface/transformers.js)
- [ONNX Runtime Web WebGPU](https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html)
- [ONNX Runtime Web Large Models](https://onnxruntime.ai/docs/tutorials/web/large-models.html)
- [@huggingface/transformers on npm](https://www.npmjs.com/package/@huggingface/transformers)
