# unzen core ドキュメント一覧

## アクティブなドキュメント

| ドキュメント | 概要 | 対象読者 |
|-------------|------|---------|
| [README.md](../README.md) | プロジェクト概要、コンセプト、SDK使い方 | 全員（初めに読む） |
| [design.md](design.md) | アーキテクチャ、サンドボックス、SDK設計 | 開発者・設計者 |
| [use-cases-and-constraints.md](use-cases-and-constraints.md) | セキュリティ制約と対象ユースケース | 全員（設計の前提理解） |
| [references.md](references.md) | 関連論文・技術文献の整理 | 研究者・設計者 |
| [oss-value-proposition.md](oss-value-proposition.md) | OSSプロジェクトとしての価値と戦略 | プロジェクト関係者 |
| [sample-functions.md](sample-functions.md) | 実践的サンプル関数のリファレンス | 開発者・利用者 |
| [nextjs-integration.md](nextjs-integration.md) | Next.js App Router への統合手順 | 開発者 |
| [fetch-only-container-site.md](fetch-only-container-site.md) | サーバを fetch のみに絞り、表示用計算を Unzen に任せるサイト構成 | 開発者・設計者 |
| [crawler-accessible-unzen-pages.md](crawler-accessible-unzen-pages.md) | Unzen ページをクローラーや link preview から取得可能にする設計 | 開発者・設計者 |
| [ad-opt-out-participation.md](ad-opt-out-participation.md) | 広告 opt-out と Unzen 計算参加を分離する設計 | 開発者・設計者 |
| [Next.js App Router 実行サンプル](../examples/nextjs-app-router/README.md) | 統合手順を検証できる最小 Next.js サンプル | 開発者 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Phase 1 MVP 実装アーキテクチャ詳細 | 開発者・設計者 |
| [heavy-samples-and-modules.md](heavy-samples-and-modules.md) | 重い処理サンプル6提案 + モジュールシステム設計 | 全員 |
| [bundler.md](bundler.md) | @unzen/bundler モジュールバンドラー設計・API | 開発者 |
| [MoonBit PoC](../moonbit-poc/README.md) | Phase 3 MoonBit wasm-gc ランタイム検証・ベンチマーク | 開発者・設計者 |

## 推奨読み順

1. **README.md** → 全体像とコンセプト
2. **use-cases-and-constraints.md** → 何ができて何ができないか
3. **design.md** → 技術的な詳細
4. **nextjs-integration.md** → Next.js App Router への組み込み方
5. **fetch-only-container-site.md** → fetch 専用サーバコンテナのサイト構成
6. **crawler-accessible-unzen-pages.md** → クローラー向け snapshot と noindex 境界
7. **ad-opt-out-participation.md** → 広告 opt-out と計算参加の境界
8. **Next.js App Router 実行サンプル** → 手元で manifest/code/exec とブラウザ実行を確認

## アーカイブについて

旧モデル（Dispatcher型分散計算）のドキュメントは
`LLM-proto/docs/archive/` に移動されています。

---

**最終更新**: 2026年2月
