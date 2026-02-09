# unzen (QJS-proto)

サーバーサイドの計算関数をブラウザ側に委任するフレームワーク。
QuickJS (Wasm) または MoonBit (Wasm) サンドボックスで安全に実行し、サーバーコストを削減する。

> **ステータス**: Phase 2 完了。ブラウザ側 QuickJS Wasm サンドボックス（4層隔離）が稼働中。313テスト通過。

## コンセプト

```js
// サーバー側で定義: この関数はブラウザで実行される
export const spamCheck = unzen.define(function(text) {
  const patterns = [/viagra/i, /casino/i, /lottery/i];
  return patterns.some(p => p.test(text));
});
```

訪問者がコメント投稿時:
1. `spamCheck` は訪問者自身のブラウザ内で実行される
2. サーバーへのリクエストは発生しない
3. ブラウザで実行できない場合はサーバーにフォールバック

**訪問者が必要とする機能を、訪問者自身のブラウザで実行する。**
サーバーは関数を定義するだけ。他人のための計算は一切ない。

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

// 関数を定義（ブラウザで実行される）
unzen.defineRaw('spamCheck', `function run(text) {
  const patterns = [/viagra/i, /casino/i, /lottery/i];
  return patterns.some(p => p.test(text));
}`);

await unzen.initialize();
app.route('/unzen', unzen.createRoutes());
```

```typescript
// client.ts - ブラウザ側
import { UnzenClient } from '@unzen/client';

const client = new UnzenClient({
  endpoint: 'http://localhost:3000/unzen',
  mode: 'production',
  workerUrl: '/worker.js', // QuickJS Wasm サンドボックス
});

// ブラウザ内で実行される。失敗時は自動でサーバーにフォールバック
const isSpam = await client.call('spamCheck', commentText);
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
| 実装状況 | **Phase 2 完了** | 未実装 (Phase 3+) |

## プロジェクト構成

```
QJS-proto/
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

- **フォームバリデーション**: 複雑なスキーマ検証をブラウザで（改竄防止）
- **価格計算**: 税金・割引・送料の改竄不能な計算
- **データ変換**: JSON/CSV/XMLの整形・変換
- **コンテンツフィルタリング**: スパム判定、NGワード検出
- **テキスト解析**: 単語数、可読性スコア、Flesch-Kincaid指標
- **Markdown変換**: SSR Markdown レンダリングをクライアントにオフロード

## 開発

```bash
# インストール
npm install

# テスト実行 (313テスト)
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

- **サーバーコスト削減**: バリデーションやデータ変換をブラウザで処理し、API呼び出しを減らす
- **レスポンス向上**: ネットワーク往復なしで即座に結果を返す
- **プライバシー**: ユーザーデータがサーバーに送信されずにブラウザ内で完結する
- **自動フォールバック**: Wasm未対応ブラウザでも同じ関数がサーバーで実行される
- **セキュリティ**: 4層隔離モデルにより、サードパーティコードの安全な実行を保証

## ドキュメント

詳細は `docs/` ディレクトリにまとめています。[ドキュメント一覧](docs/INDEX.md) を参照。

- [設計書](docs/design.md) - アーキテクチャ、サンドボックス、SDK設計
- [セキュリティ制約とユースケース](docs/use-cases-and-constraints.md) - 外部接続禁止ポリシー
- [学術参考文献](docs/references.md) - Wasm セキュリティ、サンドボックス関連論文

## ライセンス

未定 (MIT or AGPL を検討中)
