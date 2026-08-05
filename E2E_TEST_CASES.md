# unzen core E2E Test Cases

## テスト対象
- **プロジェクト**: unzen core
- **URL**: http://localhost:3000
- **概要**: ブラウザ上でQuickJS Wasmサンドボックスを使い、サーバー定義関数をブラウザ側で実行するデモアプリ

## テストケース

### TC-001: トップページの表示と基本要素の確認
- **カテゴリ**: 公開ページ
- **authRequired**: false
- **手順**:
  1. http://localhost:3000/ にアクセス
  2. ページタイトルを確認
  3. 主要な見出しとセクションが表示されていることを確認
- **期待結果**:
  - タイトル: "unzen core E2E Demo"
  - h1タグに "unzen core E2E Demo" が含まれる
  - 8つのデモセクション + 統計セクションが表示される

### TC-002: Spam Detection機能の動作確認
- **カテゴリ**: 公開ページ
- **authRequired**: false
- **手順**:
  1. "Spam Detection" セクションのテキストエリアにスパムテキストを入力
  2. "Check for Spam" ボタンをクリック
  3. 結果が表示されることを確認
- **期待結果**:
  - "Buy now and get free money!" → true (スパム検出)
  - 結果にバッジ(Browser/Server)と実行時間が表示される

### TC-003: Multiply Numbers機能の動作確認
- **カテゴリ**: 公開ページ
- **authRequired**: false
- **手順**:
  1. "Multiply Numbers" セクションの入力フィールドに数値を入力
  2. "Multiply" ボタンをクリック
  3. 結果を確認
- **期待結果**:
  - 5 × 7 = 35
  - 実行場所バッジが表示される

### TC-004: Double Array機能の動作確認
- **カテゴリ**: 公開ページ
- **authRequired**: false
- **手順**:
  1. "Double Array Values" セクションに配列を入力
  2. "Double Array" ボタンをクリック
  3. 結果を確認
- **期待結果**:
  - [1,2,3,4,5] → [2,4,6,8,10]

### TC-005: User Info Transformer機能の動作確認
- **カテゴリ**: 公開ページ
- **authRequired**: false
- **手順**:
  1. "User Info Transformer" セクションにユーザー情報を入力
  2. "Transform User" ボタンをクリック
  3. 結果を確認
- **期待結果**:
  - fullName: "John Doe"
  - isAdult: true
  - initials: "JD"

### TC-006: Form Validation機能の動作確認
- **カテゴリ**: 公開ページ
- **authRequired**: false
- **手順**:
  1. "Form Validation" セクションに各フィールドを入力
  2. "Validate" ボタンをクリック
  3. バリデーション結果を確認
- **期待結果**:
  - 結果にバリデーション状態が表示される
  - 実行場所とタイミング情報が表示される

### TC-007: Price Calculator機能の動作確認
- **カテゴリ**: 公開ページ
- **authRequired**: false
- **手順**:
  1. "Price Calculator" セクションにアイテムとリージョンを入力
  2. "Calculate Price" ボタンをクリック
  3. 計算結果を確認
- **期待結果**:
  - 価格計算結果（税、割引、送料含む）が表示される

### TC-008: Markdown to HTML機能の動作確認
- **カテゴリ**: 公開ページ
- **authRequired**: false
- **手順**:
  1. "Markdown to HTML" セクションにMarkdownテキストを入力
  2. "Convert to HTML" ボタンをクリック
  3. 変換結果とプレビューを確認
- **期待結果**:
  - HTMLに変換された結果が表示される
  - サンドボックス化されたiframeプレビューが表示される

### TC-009: Text Statistics機能の動作確認
- **カテゴリ**: 公開ページ
- **authRequired**: false
- **手順**:
  1. "Text Statistics" セクションにテキストを入力
  2. "Analyze Text" ボタンをクリック
  3. 統計結果を確認
- **期待結果**:
  - 単語数、文数、可読性スコア等が表示される

### TC-010: 実行統計の更新確認
- **カテゴリ**: 公開ページ
- **authRequired**: false
- **手順**:
  1. 複数のデモ関数を実行
  2. ページ下部の "Execution Statistics" セクションを確認
- **期待結果**:
  - Browser Executions カウントが増加
  - Avg Execution Time が更新される

### TC-011: Manifest APIエンドポイント確認
- **カテゴリ**: 公開ページ
- **authRequired**: false
- **手順**:
  1. /unzen/manifest にアクセス
  2. JSON レスポンスを確認
- **期待結果**:
  - 登録された関数の一覧がJSON形式で返される
  - spamCheck, add, multiply 等の関数が含まれる

### TC-012: JavaScriptエラーの確認
- **カテゴリ**: 公開ページ
- **authRequired**: false
- **手順**:
  1. ページを開いた状態でコンソールエラーを確認
  2. 各デモ操作後にエラーがないことを確認
- **期待結果**:
  - 重大なJavaScriptエラーがないこと

### TC-013: ブラウザ側実行の確認 (QuickJS Wasm)
- **カテゴリ**: 公開ページ
- **authRequired**: false
- **手順**:
  1. デモ関数を実行
  2. 結果のバッジを確認
- **期待結果**:
  - "Browser (QuickJS Wasm)" バッジが表示される（ブラウザ側で実行されている証拠）
