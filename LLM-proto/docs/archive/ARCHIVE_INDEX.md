# アーカイブドキュメント一覧

このディレクトリには、プロジェクト方針変更（2026-02-05）により
無効となったドキュメントが保管されています。
歴史的参考のためにのみ保管されており、内容に基づいて意思決定しないでください。

**権威的ドキュメント**: [LLM-proto/PLAN.md](../../PLAN.md) (v2.6)

---

## ファイル一覧

| ファイル | 元の場所 | 廃止理由 | 代替ドキュメント |
|---------|---------|----------|----------------|
| business-strategy.md | QJS-proto/docs/ | QJSはOSSプロジェクトとして確定。商用化は対象外。セキュリティ制約とユースケースは別途抽出済み | QJS-proto/docs/use-cases-and-constraints.md, QJS-proto/docs/design.md |
| business-framework-integration.md | QJS-proto/docs/ | フレームワーク統合（ISR/SSG）は外部接続禁止ポリシーと矛盾するため対象外 | PLAN.md セクション6（変更点一覧） |
| strategic-synergy-qjs-llm.md | QJS-proto/docs/ | QJSとLLMは独立プロジェクトとして確定。シナジー前提の戦略は無効 | PLAN.md セクション1.3 |
| worker-acquisition-ideas.md | QJS-proto/docs/ | 探索的メモ。PLAN.md v2.6で方針確定済み | PLAN.md セクション4.5（特に4.5.6） |
| innovative-worker-models.md | QJS-proto/docs/ | 探索的メモ。PLAN.md v2.6で方針確定済み | PLAN.md セクション2-3 |
| detailed-cost-calculation.md | QJS-proto/docs/ | コスト試算に矛盾あり（70B: $0.0085）。PLAN.md v2.6で「未確定」と判定 | PLAN.md セクション4, 6 |
| complete-cost-calculation-v2.md | QJS-proto/docs/ | コスト試算に矛盾あり（70B: $0.0015）。PLAN.md v2.6で「未確定」と判定 | PLAN.md セクション4, 6 |
| distributed-dispatcher.md | QJS-proto/docs/ | 自己消費モデルへの移行により分散ディスパッチャー設計は不要 | QJS-proto/docs/design.md (v3.0) |

---

**作成日**: 2026-02-06
