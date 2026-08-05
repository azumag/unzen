# unzen core E2E Demo

QuickJS Wasm サンドボックスによるブラウザ側関数実行のデモページである。4層隔離モデルの動作を確認できる。

> このページは **デモ** であり、本番システムではありません。所要時間・統計は
> このセッション内での実測値で、再読み込みでリセットされます。セキュリティ境界の
> 主張は [デモページ内の説明](#security-boundaries) の範囲に限定されます。

## 起動方法

```bash
# プロジェクトルートから
npm install
npm run build

# デモサーバー起動
cd demo
npm install
npm run dev
# → http://localhost:3000
```

## デモ関数 (8種)

### 基本デモ
1. **Spam Detection** - テキストのスパム判定を行う
2. **Math Operations** - 数値の乗算を行う
3. **Array Transformations** - 配列要素を倍化する
4. **Object Manipulation** - ユーザー情報を変換する

### 実用デモ (サーバー委任パターン)
5. **Form Validation** - メール/クレジットカード/電話番号/パスワードのバリデーション（**架空サンプルのみ**）
6. **Price Calculator** - 税金・割引・送料を計算する
7. **Markdown to HTML** - SSR の Markdown レンダリングをクライアントにオフロードする
8. **Text Statistics** - 単語数・可読性スコア・Flesch-Kincaid指標を算出する

## UI アーキテクチャ (issue #104)

ページはすべてモジュールベースのイベントリスナーで配線される。インラインの
`onclick` やグローバル `window.*` ハンドラはない。スタイルは `public/demo.css`
のデザイントークン(CSS カスタムプロパティ)に分離され、状態は `[data-state]`
属性として各デモセクションに反映される。

### ファイル構成

| ファイル | 役割 |
|---------|------|
| `public/index.html` | セマンティック HTML。状態・コピーは `data-i18n` で参照 |
| `public/demo.css` | デザイントークン・状態クラス・focus-visible・reduced-motion・モバイル対応 |
| `public/demo.js` | ブラウザ配線。共有 `runDemo()` パイプライン・DOM レンダリング・統計表示 |
| `public/demo-state.js` | **純粋** 状態機械 (reducer)。`eventToState()` で SDK イベント型→UI 状態 |
| `public/demo-stats.js` | **純粋** 統計モデル。成果を別バケットでカウント、平均はサンプル数付き |
| `public/demo-validate.js` | **純粋** 入力検証。配列トークン位置・JSON 位置付きパース・シェイプ検証 |
| `public/demo-diagnostics.js` | **純粋** 診断情報のランタイムスキーマチェックとエラーコード分類 |
| `public/demo-i18n.js` | **純粋** en/ja コピー辞書と `t()` ルックアップ |

純粋モジュールはブラウザ(`demo.js`)と vitest の両方からインポートされる。

### 状態機械

各デモは次の状態を持つ: `idle / validating / preparing / running-in-browser /
falling-back-to-server / running-on-server / succeeded / failed / cancelling /
cancelled`

SDK の実行イベント(type)を `demo-state.js` の `eventToState()` が UI 状態に
マップする。メッセージ文字列のパースは一切行わない。

| SDK イベント | UI 状態 |
|-------------|--------|
| `accepted` / `manifest-fetch-*` / `code-fetch-*` | `preparing` |
| `browser-execution-started` | `running-in-browser` |
| `browser-execution-failed` / `fallback-started` | `falling-back-to-server` |
| `server-execution-started` | `running-on-server` |
| `completed` | `succeeded` |
| `cancel-requested` | `cancelling` |
| `cancelled` | `cancelled` |
| `failed` | `failed` |

### 実行パイプライン

全デモは同一の `runDemo()` パイプラインを通る（Markdown デモも同様。成功後
フックでサンドボックス化 iframe に結果を描画する）。

1. ビジーガード(`canSubmit`)で二重送信を防ぐ
2. 入力検証 → フィールド単位のエラー表示 + `aria-invalid` / `aria-describedby`
3. 各デモ専用の `AbortController` を生成し、`client.executeWithDiagnostics({ name, args, signal, onEvent })` を呼ぶ
4. `onEvent` でイベント型→状態遷移 + ライブ試行チェーン表示
5. 完了後 `diagnostics.attempts` から確定版の試行チェーンを描画
6. エラーは安定エラーコード(`cancelled` / `manifest_fetch_failed` / ...)で分類し、種類ごとに異なるコピーと配色で表示

キャンセルボタンは `AbortController.abort()` を送る。SDK (issue #105) は
ユーザーキャンセルがサーバーフォールバックを起動しないことを保証する。UI は
`cancelling → cancelled` を表示し、汎用エラーにはしない。

### 統計

- **成果は別々にカウント**: ブラウザ成功 / フォールバック成功 / 入力エラー /
  関数エラー / 実行時エラー / サーバーエラー / ネットワークエラー / キャンセル /
  キャッシュヒット / 不明
- 平均は「総所要時間」「ブラウザ試行」「サーバー試行」を別サンプルセットで保持し、
  それぞれサンプル数(`n=…`)を表示する
- 値はセッションローカル。再読み込みまたは「Reset all」で初期化される
- 各統計の定義はページ下部の `<details>` に表示される

### アクセシビリティ

- 状態領域は `role="status"` / `aria-live="polite"`。preparing / running /
  fallback / completed / error / cancelled をアナウンス
- 入力エラー時は最初のエラー項目へフォーカスを移動。終端状態では結果領域へ移動
- 実行中ボタンは `disabled` + `aria-busy`
- `:focus-visible` スタイル、`prefers-reduced-motion` 対応、モバイルで横スクロールなし
- en/ja の最小 i18n 切替(ヘッダー)。コピーは `demo-i18n.js` に一元化

## セキュリティ

関数は4層隔離サンドボックス内で実行:
- **Layer 1**: Web Worker (別スレッド、DOM アクセス不可)
- **Layer 2**: Wasm sandbox (メモリ隔離)
- **Layer 3**: QuickJS interpreter (V8 とは別の JS エンジン)
- **Layer 4**: API 制限 (eval/Function/Proxy 削除、プロトタイプ凍結)

制約:
- 外部接続は禁止されている (fetch, WebSocket, XHR 等)
- メモリ制限: 16MB
- タイムアウト: 5000ms (ブラウザ側) / 50ms (サーバー側)
- 純粋計算のみを許可する（入力→計算→出力、副作用なし）

**境界の正確な記述**: サンドボックスは未検証の関数コードをページから隔離する
（メインスレッド・DOM から分離）。これはサーバー側の信頼境界・CSP・認証の
代替ではない。デモページの「Security boundaries」欄も同旨。

## 実行フロー

1. **クライアント初期化**: `new UnzenClient({ endpoint, workerUrl: '/worker.js' })`
2. **関数呼び出し**: `client.executeWithDiagnostics({ name, args, signal, onEvent })`
3. **マニフェスト取得**: `GET /unzen/manifest` で関数一覧取得
4. **コード取得**: `GET /unzen/code/spamCheck` でソースコード取得
5. **ブラウザ実行**: Web Worker 内の QuickJS Wasm サンドボックスで実行
6. **フォールバック**: ブラウザ実行失敗時のみ `POST /unzen/exec/spamCheck`

## API エンドポイント

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/unzen/manifest` | GET | 登録関数のメタデータ (名前, ハッシュ) |
| `/unzen/code/:name` | GET | 関数ソースコード |
| `/unzen/exec/:name` | POST | サーバー側フォールバック実行 |
| `/worker.js` | GET | QuickJS Wasm Worker バンドル |
| `/client.js` | GET | クライアントSDKバンドル |

エンドポイントはデモページから `location.origin` を基に解決される
(`/unzen`)。HTTPS での mixed content を避けるため、`http://localhost:3000`
のハードコードはない。デプロイで上書きする場合は
`window.UNZEN_DEMO_CONFIG = { endpoint: '…' }` を設定する。

## テスト

```bash
# デモ単体/統合テスト (vitest)
cd demo
npm test

# サーバー起動後の E2E スクリプト
bash test-e2e.sh
```

- `tests/demo-state.test.ts` — 状態機械（二重送信ガード、イベント→状態、キャンセル遷移）
- `tests/demo-stats.test.ts` — 統計モデル（別バケット集計、平均のサンプル数、RESET）
- `tests/demo-validate.test.ts` — 入力検証（配列トークン位置、JSON 位置付きパース、シェイプ検証）
- `tests/demo-diagnostics.test.ts` — 診断情報のスキーマチェックとエラーコード分類
- `tests/demo-i18n.test.ts` — en/ja 辞書のキー完全一致
- `tests/server-fallback.test.ts` — フォールバック HTTP プロトコル契約
- `tests/integration.test.ts` — サーバー統合スモークテスト
