# unzen core

サーバーサイドの計算関数をブラウザ側に委任するフレームワーク。
QuickJS (Wasm) または MoonBit (Wasm) サンドボックスで安全に実行し、サーバーコストを削減する。

> **ステータス**: Phase 3 進行中。モジュールバンドラー(@unzen/bundler)が稼働中。447テスト通過。

## コンセプト

```js
// サーバー側で定義: この関数はブラウザで実行される
unzen.defineRaw('jsonSchemaValidate', schemaValidateCode, { timeout: 500 });
```

API リクエストの JSON Schema 検証を例にすると:
1. `jsonSchemaValidate` は訪問者自身のブラウザ内で実行される
2. 不正なリクエストはサーバーに到達する前にブロックされる
3. ブラウザで実行できない場合はサーバーにフォールバック

**訪問者が必要とする機能を、訪問者自身のブラウザで実行する。**
サーバーは関数を定義するだけ。他人のための計算は一切ない。

## サーバーコスト削減シミュレーション

| 処理 | サーバーCPU/回 | 月間リクエスト | 年間サーバーコスト | unzen使用時 |
|------|--------------|-------------|-----------------|------------|
| JSON Schema検証 | ~15ms | 10M | $1,330 | $0 |
| ダッシュボードソート | ~20ms | 5M | $886 | $0 |
| テキスト類似度計算 | ~40ms | 2M | $710 | $0 |
| フォームバリデーション | ~5ms | 10M | $443 | $0 |
| Markdown変換 | ~20ms | 5M | $886 | $0 |
| **合計** | | | **$4,255/年** | **$0** |

> 前提: $0.05/hr compute (AWS t3.medium 相当)

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

// 重量関数: JSON Schema バリデーション (500ms タイムアウト)
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

// 100フィールドのスキーマ検証がブラウザ内で完了
// 不正リクエストはサーバーに到達しない
const result = await client.call('jsonSchemaValidate', userSchema, requestBody);
if (!result.valid) {
  showErrors(result.errors);
}
```

## 重量処理サンプル

### `jsonSchemaValidate` — JSON Schema バリデーション（年間 $1,330 節約）

100フィールドのスキーマ検証をブラウザで実行。不正な API リクエストがサーバーに到達する前にブロック。

```js
const schema = {
  type: 'object',
  required: ['name', 'email', 'age'],
  properties: {
    name: { type: 'string', minLength: 1 },
    email: { type: 'string', pattern: '^[^@]+@[^@]+$' },
    age: { type: 'integer', minimum: 0, maximum: 150 },
    address: {
      type: 'object',
      properties: {
        city: { type: 'string' },
        zip: { type: 'string', pattern: '^\\d{5}$' },
      },
    },
  },
};

const result = await client.call('jsonSchemaValidate', schema, formData);
// → { valid: true, errors: [] }
// → { valid: false, errors: ['$.email: string does not match pattern ...'] }
```

### `sortData` — マルチキーソート（年間 $886 節約）

5,000行のダッシュボードテーブルをネットワーク往復なしでソート。

```js
const sorted = await client.call('sortData', tableData, [
  { key: 'department', order: 'asc' },
  { key: 'salary', order: 'desc' },
]);
// → 部門昇順 → 給与降順でソートされた配列
```

### `levenshteinDistance` — テキスト類似度（年間 $710 節約）

O(n*m) の編集距離計算。重複検出やファジー検索のサーバーCPUを大幅に削減。

```js
const result = await client.call('levenshteinDistance', 'kitten', 'sitting');
// → { distance: 3, similarity: 0.57 }
```

## タイムアウト階層

| Tier | Timeout | 用途 |
|------|---------|------|
| default | 50ms | バリデーション、フィルタリング、軽量計算 |
| medium | 500ms | スキーマ検証、データソート、テキスト解析 |
| heavy | 2,000ms | 大規模データ処理、暗号ハッシュ |

```typescript
// タイムアウトは defineRaw の第3引数で指定
unzen.defineRaw('lightFunc', code);                    // 50ms (default)
unzen.defineRaw('mediumFunc', code, { timeout: 500 }); // 500ms
unzen.defineRaw('heavyFunc', code, { timeout: 2000 }); // 2,000ms
```

## 4層隔離モデル (Phase 2)

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
│   │   └── src/
│   │       ├── sandbox-security.ts  # サンドボックスセキュリティ初期化 (サーバー・クライアント共通)
│   │       ├── errors.ts            # UnzenFunctionError / UnzenRuntimeError / UnzenNetworkError
│   │       ├── types.ts             # ManifestEntry, ExecutionOptions 等
│   │       └── protocol.ts          # HTTP プロトコル型
│   ├── server/         # サーバーSDK (@unzen/server)
│   │   └── src/
│   │       ├── unzen-server.ts      # メインサーバークラス
│   │       ├── function-registry.ts # 関数レジストリ
│   │       ├── quickjs-runtime.ts   # サーバー側 QuickJS ランタイム
│   │       └── manifest-builder.ts  # マニフェストビルダー
│   ├── bundler/        # モジュールバンドラー (@unzen/bundler)
│   │   └── src/
│   │       ├── bundler.ts             # esbuildラッパー + セキュリティプラグイン
│   │       ├── module-whitelist.ts    # モジュールホワイトリスト検証
│   │       ├── forbidden-api-check.ts # 禁止API検出（防御多層）
│   │       └── index.ts              # パッケージエントリポイント
│   └── client/         # クライアントSDK (@unzen/client)
│       └── src/
│           ├── unzen-client.ts       # メインクライアントクラス
│           ├── web-worker-sandbox.ts # WebWorkerSandboxExecutor (Phase 2)
│           ├── quickjs-sandbox.ts    # SandboxExecutor インターフェース
│           ├── worker/
│           │   ├── quickjs-worker.ts    # Worker スクリプト (QuickJS Wasm)
│           │   └── worker-protocol.ts   # Worker メッセージプロトコル
│           ├── fallback-handler.ts   # サーバーフォールバック
│           ├── manifest-fetcher.ts   # マニフェスト取得
│           └── code-fetcher.ts       # 関数コード取得
└── demo/               # E2Eデモサーバー
    ├── server.ts
    └── public/
```

## 想定ユースケース

**軽量処理** (50ms):
- **フォームバリデーション**: 複雑なスキーマ検証をブラウザで（改竄防止）
- **価格計算**: 税金・割引・送料の改竄不能な計算
- **コンテンツフィルタリング**: スパム判定、NGワード検出

**中量処理** (500ms) — サーバーコスト削減効果大:
- **JSON Schema 検証**: APIリクエスト検証をブラウザに委譲（~$1,330/年 節約）
- **データソート**: ダッシュボードの大規模テーブルソート（~$886/年 節約）
- **テキスト類似度**: Levenshtein距離による重複検出（~$710/年 節約）
- **テキスト解析**: 単語数、可読性スコア、Flesch-Kincaid指標

**重量処理** (2,000ms):
- **大規模データ変換**: JSON/CSV/XMLの整形・変換
- **暗号ハッシュ**: PBKDF2等のパスワードハッシュ

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

## 類似プロジェクトとの違い

| プロジェクト | アプローチ | unzen との違い |
|---|---|---|
| Qwik | `$` 境界でクライアント実行を制御 | UIレンダリング専用。汎用計算ではない |
| React RSC | `"use server"` / `"use client"` | クライアント→サーバー方向。逆 |
| wasi-worker | WASIバイナリをブラウザで実行 | 低レベルランタイムのみ。DXフレームワークなし |
| Comlink | Web Worker を透過的に呼び出し | ブラウザ内のスレッド間のみ。サーバー委任なし |

## なぜ unzen？

- **サーバーコスト削減**: バリデーションやデータ変換をブラウザで処理し、API呼び出しを減らす（年間$4,000+削減）
- **レスポンス向上**: ネットワーク往復なしで即座に結果を返す
- **プライバシー**: ユーザーデータがサーバーに送信されずにブラウザ内で完結する
- **自動フォールバック**: Wasm未対応ブラウザでも同じ関数がサーバーで実行される
- **セキュリティ**: 4層隔離モデルにより、サードパーティコードの安全な実行を保証

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
