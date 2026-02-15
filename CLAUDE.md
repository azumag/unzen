# LAW
- research the industry-standard approach to this problem use it to guide yours"
- 適切に作業を subagent に移譲し、コンテキストウィンドウを節約せよ。
- Detailed comments must be included in the source code to justify the implementation of such logic
- use T-wada TDD
- テストに失敗したら、作業に関係なくとも、subagentに委任して修正を行うこと
- 構造の変更や昨日の追加があった場合、docsのドキュメントを適切に更新し、README.md に参照を追加する。必要があればREADME.mdも更新する。

## REVIEW
- 作業内容は subagent を用いて厳しい自己レビューを実施すること
- コードの重複や簡潔性、無駄なファイルを作っていないかどうか、使いやすさ、セキュリティリスク、コストなどの>あらゆる点について厳しく指摘してください
- レビュー修正した後は再度レビューを実施し、レビューの指摘が完全にクリアされるまで、修正とレビューを繰り返>せ
- レビュワーはかなり厳しいので、指摘がなくなるようにしろ

### review aspects
- Code quality and best practices
- Potential bugs and edge cases
- Performance implications
- Security considerations
- **コードの簡潔性**: 過度な抽象化や複雑化を避ける
- 単体テストのカバレッジは十分か？
- YAGNI の原則に乗っ取り、過剰な実装と設計を避ける

レビュー修正した後は再度レビューを受け、レビューの指摘が完全にクリアされるまで、修正とレビューを繰り返せ

