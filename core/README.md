# unzen core

サーバーサイドの計算関数をブラウザ側に委任するフレームワーク。
QuickJS (Wasm) または MoonBit (Wasm) サンドボックスで安全に実行する。

> **ステータス**: Phase 3 進行中。モジュールバンドラー(@unzen/bundler)が稼働中。447テスト通過。

## コンセプト

**訪問者が必要とする機能を、訪問者自身のブラウザで実行する。**
サーバーは関数を定義するだけ。他人のための計算は一切ない。

1. サーバーで関数を定義
2. 訪問者のブラウザ内の QuickJS Wasm サンドボックスで実行
3. ブラウザで実行できない場合はサーバーにフォールバック

## 基本的な使い方

```bash
npm install @unzen/server @unzen/client
```

```typescript
// server.ts - サーバー側
import { UnzenServer } from '@unzen/server';
import { Hono } from 'hono';

const app = new Hono();
const unzen = new UnzenServer({ baseUrl: 'http://localhost:3000/unzen' });

// JSON Schema バリデーション — ブラウザで実行される
unzen.defineRaw('jsonSchemaValidate', `function run(schema, data) {
  function validate(schema, data, path) {
    var errors = [];
    // ... 再帰的スキーマ検証 (型、必須、パターン、ネスト対応)
    return errors;
  }
  var errors = validate(schema, data, '$');
  return { valid: errors.length === 0, errors: errors };
}`, { timeout: 500 });

await unzen.initialize();
app.route('/unzen', unzen.middleware());
```

```typescript
// client.ts - ブラウザ側
import { UnzenClient } from '@unzen/client';

const client = new UnzenClient({
  endpoint: 'http://localhost:3000/unzen',
  mode: 'production',
  workerUrl: '/worker.js',
});

// スキーマ検証がブラウザ内で完了。サーバーへのリクエスト不要
const result = await client.call('jsonSchemaValidate', userSchema, requestBody);
if (!result.valid) {
  showErrors(result.errors);
}
```

## サンプル関数

### `jsonSchemaValidate` — JSON Schema バリデーション

API リクエストの検証をブラウザで実行。不正なリクエストがサーバーに到達する前にブロック。
ネストしたオブジェクトや配列も再帰的に検証し、エラーパス付きで結果を返す。

```js
const schema = {
  type: 'object',
  required: ['name', 'email'],
  properties: {
    name: { type: 'string', minLength: 1 },
    email: { type: 'string', pattern: '^[^@]+@[^@]+$' },
    address: {
      type: 'object',
      properties: {
        zip: { type: 'string', pattern: '^\\d{5}$' },
      },
    },
  },
};

await client.call('jsonSchemaValidate', schema, formData);
// → { valid: true, errors: [] }
// → { valid: false, errors: ['$.email: string does not match pattern ...'] }
```

### `sortData` — マルチキーデータソート

ダッシュボードテーブルのソートをネットワーク往復なしで実行。

```js
const sorted = await client.call('sortData', tableData, [
  { key: 'department', order: 'asc' },
  { key: 'salary', order: 'desc' },
]);
// → 部門昇順 → 給与降順でソートされた配列
```

### `levenshteinDistance` — テキスト類似度

O(n*m) の編集距離計算。ファジー検索や重複検出をブラウザ内で実行。

```js
await client.call('levenshteinDistance', 'kitten', 'sitting');
// → { distance: 3, similarity: 0.57 }
```

### その他のサンプル

- **`formValidate`** — メール・クレジットカード(Luhn)・電話番号・パスワードの複合検証
- **`calculatePrice`** — 税金・割引・送料の改竄不能な価格計算
- **`markdownToHtml`** — Markdown→HTML 変換（XSS 防止付き）
- **`textStats`** — 単語数・可読性スコア（Flesch-Kincaid）

詳細は [サンプル関数リファレンス](docs/sample-functions.md) を参照。

## なぜ unzen？

- **レスポンス向上**: ネットワーク往復なしで即座に結果を返す
- **サーバー負荷軽減**: バリデーションやデータ変換をブラウザで処理し、API呼び出しを減らす
- **プライバシー**: ユーザーデータがサーバーに送信されずにブラウザ内で完結する
- **自動フォールバック**: Wasm未対応ブラウザでも同じ関数がサーバーで実行される
- **セキュリティ**: 4層隔離モデルにより、サードパーティコードの安全な実行を保証

## タイムアウト階層

| Tier | Timeout | 用途 |
|------|---------|------|
| default | 50ms | バリデーション、フィルタリング、軽量計算 |
| medium | 500ms | スキーマ検証、データソート、テキスト解析 |
| heavy | 2,000ms | 大規模データ処理、暗号ハッシュ |

```typescript
unzen.defineRaw('lightFunc', code);                    // 50ms (default)
unzen.defineRaw('mediumFunc', code, { timeout: 500 }); // 500ms
unzen.defineRaw('heavyFunc', code, { timeout: 2000 }); // 2,000ms
```

## 4層隔離モデル

ブラウザ側の関数実行は4層のセキュリティ隔離で保護される:

```
Browser Main Thread                  Web Worker Thread
┌─────────────────────┐             ┌──────────────────────────┐
│ UnzenClient         │  postMsg    │ Layer 1: Web Worker      │
│  └─ WebWorkerSandbox├────────────►│  └─ Layer 2: Wasm sandbox│
│     Executor        │◄────────────┤     └─ Layer 3: QuickJS  │
│     (timeout guard) │  postMsg    │        └─ Layer 4: API制限│
└─────────────────────┘             └──────────────────────────┘
```

| 層 | 隔離内容 |
|---|---|
| Layer 1: Web Worker | 別スレッド、DOMアクセス不可 |
| Layer 2: Wasm sandbox | メモリ隔離（ホストからアクセス不可） |
| Layer 3: QuickJS | 独立JSエンジン（V8とは別） |
| Layer 4: API制限 | eval/Function/Proxy削除、プロトタイプ凍結 |

## セキュリティ

関数はサンドボックス内で実行される:
- **外部接続禁止**: fetch, WebSocket, XHR 等は一切使えない
- **DOM アクセス不可**: Web Worker 内で隔離実行
- **リソース制限**: メモリ 16MB、実行時間タイムアウト（協調 + 強制停止）
- **純粋計算のみ**: 入力→計算→出力。副作用なし
- **プロトタイプ汚染防止**: Object/Array/String等の全ビルトインプロトタイプを凍結
- **コンストラクタチェーン切断**: Function/AsyncFunction/GeneratorFunction/AsyncGeneratorFunction全4種

## 2つのランタイム

| | QuickJS (JS) | MoonBit (Wasm) |
|---|---|---|
| 言語 | JavaScript | MoonBit |
| 実行方式 | Wasm上でJSを解釈実行 | wasm-gc にネイティブコンパイル |
| サイズ | ~150KB (gzip) + 関数コード | 関数ごとに数百B〜数十KB |
| 性能 | 短時間関数に十分 (50ms以内) | Rustに近い高速実行 |
| ブラウザ | ほぼ全ブラウザ | wasm-gc対応 (Chrome 119+, Firefox 120+, Safari 18+) |
| 用途 | 手軽にJS関数を委任 | 性能が重要な計算処理 |
| 実装状況 | **Phase 2 完了** | **Phase 3 PoC** (ビルド検証済) |

## プロジェクト構成

```
core/
├── moonbit-poc/           # MoonBit wasm-gc PoC (Phase 3)
│   ├── fibonacci/         # fibonacci ベンチマーク (8.2KB wasm)
│   ├── sort/              # quicksort ベンチマーク (9.0KB wasm)
│   └── benchmark/         # ブラウザベンチマーク UI
├── packages/
│   ├── shared/         # 共有型定義・エラー・セキュリティコード
│   ├── server/         # サーバーSDK (@unzen/server)
│   ├── bundler/        # モジュールバンドラー (@unzen/bundler)
│   └── client/         # クライアントSDK (@unzen/client)
└── demo/               # E2Eデモサーバー
```

## 想定ユースケース

**軽量処理** (50ms):
- **フォームバリデーション**: 複雑なスキーマ検証をブラウザで（改竄防止）
- **価格計算**: 税金・割引・送料の改竄不能な計算
- **コンテンツフィルタリング**: スパム判定、NGワード検出

**中量処理** (500ms):
- **JSON Schema 検証**: APIリクエスト検証をブラウザに委譲
- **データソート**: ダッシュボードの大規模テーブルソート
- **テキスト類似度**: Levenshtein距離による重複検出
- **テキスト解析**: 単語数、可読性スコア、Flesch-Kincaid指標

**重量処理** (2,000ms):
- **大規模データ変換**: JSON/CSV/XMLの整形・変換
- **暗号ハッシュ**: PBKDF2等のパスワードハッシュ

## 類似プロジェクトとの違い

| プロジェクト | アプローチ | unzen との違い |
|---|---|---|
| Qwik | `$` 境界でクライアント実行を制御 | UIレンダリング専用。汎用計算ではない |
| React RSC | `"use server"` / `"use client"` | クライアント→サーバー方向。逆 |
| wasi-worker | WASIバイナリをブラウザで実行 | 低レベルランタイムのみ。DXフレームワークなし |
| Comlink | Web Worker を透過的に呼び出し | ブラウザ内のスレッド間のみ。サーバー委任なし |

## 開発

```bash
# インストール
npm install

# テスト実行 (447テスト)
npx vitest run

# ビルド
npm run build

# デモ起動
cd demo && npm run dev
# → http://localhost:3000
```

## ドキュメント

詳細は `docs/` ディレクトリにまとめています。[ドキュメント一覧](docs/INDEX.md) を参照。

- [設計書](docs/design.md) - アーキテクチャ、サンドボックス、SDK設計
- [サンプル関数リファレンス](docs/sample-functions.md) - 全サンプル関数の仕様・入出力・例
- [モジュールバンドラー](docs/bundler.md) - @unzen/bundler の設計と使い方
- [セキュリティ制約とユースケース](docs/use-cases-and-constraints.md) - 外部接続禁止ポリシー
- [学術参考文献](docs/references.md) - Wasm セキュリティ、サンドボックス関連論文
- [MoonBit wasm-gc PoC](moonbit-poc/README.md) - Phase 3 MoonBit ランタイム検証 (ビルド済み、ブラウザベンチマーク付き)

## ライセンス

未定 (MIT or AGPL を検討中)
