# @unzen/bundler - モジュールバンドラー

npm 依存関係を含むサンドボックス関数をバンドルし、QuickJS サンドボックスで実行可能な自己完結型コードを生成する。

## 概要

サンドボックス関数は通常、外部依存関係なしの純粋な JavaScript で記述されるが、`lodash` や `date-fns` のような計算ライブラリを使いたい場合がある。`@unzen/bundler` は esbuild を使ってこれらの依存関係をビルド時にバンドルし、サンドボックスで安全に実行可能な単一ファイルを生成する。

## セキュリティモデル

### 3層防御 (Defense-in-Depth)

```
Layer 1: モジュールホワイトリスト（静的プリチェック）
  └── import文を解析し、許可リストと照合

Layer 2: esbuild onResolve プラグイン（解決時チェック）
  └── esbuild がモジュールを解決する際にALL解決パスを検証
  └── エイリアス・推移的依存を含む全てのモジュールをブロック可能

Layer 3: 禁止API検出（バンドル後スキャン）
  └── バンドルされた出力に禁止APIが含まれていないかスキャン
  └── fetch, WebSocket, eval, new Function, require, import() 等を検出
```

### ブロックされるモジュール

- **Node.js 組み込みモジュール**: `fs`, `child_process`, `net`, `http`, `crypto` 等（常にブロック、ホワイトリストに追加しても無効）
- **ホワイトリスト外の npm モジュール**: 明示的に許可されていないモジュール
- **パストラバーサル**: `lodash/../../evil` のような攻撃パターン

### ブロックされるAPI

- `fetch()` - ネットワークリクエスト
- `XMLHttpRequest` - ネットワークリクエスト
- `WebSocket` - ネットワーク接続
- `eval()` - 動的コード実行
- `new Function()` - 動的コード実行
- `require()` - 動的モジュールロード
- `import()` - 動的インポート
- `importScripts` - スクリプトロード

## 使い方

### `define()` のコンパイル時抽出

Vite pluginとwebpack loaderは同じTypeScript AST変換を使用する。`@unzen/server`
からimportした`UnzenServer`の`const`インスタンスに対する、トップレベルのinline同期
関数だけを`defineRaw()`へ変換する。対象call以外のソースはMagicStringで保持し、source
mapも返す。

```typescript
// functions.ts
import { UnzenServer } from '@unzen/server';

const server = new UnzenServer({ baseUrl: '/unzen' });
server.define('sum', (a: number, b: number): number => a + b, {
  timeout: 500,
});
```

build後の意味上の出力:

```javascript
server.defineRaw("sum", "(a, b) => a + b", { timeout: 500 });
```

#### Vite

Vite標準の`transform` hookを`enforce: 'pre'`で使用する。

```typescript
// vite.config.ts
import { defineConfig } from 'vite';
import { unzenVitePlugin } from '@unzen/bundler';

export default defineConfig({
  plugins: [
    unzenVitePlugin({
      include: /\/server\//,
      exclude: /\.generated\.ts$/,
    }),
  ],
});
```

#### webpack

webpack loaderはraw TypeScriptを読む必要がある。loaderは右から左へ実行されるため、
Unzen loaderを`use`の右端（最初に実行される位置）へ置く。

```javascript
// webpack.config.cjs
module.exports = {
  module: {
    rules: [{
      test: /\.[cm]?[jt]sx?$/,
      exclude: /node_modules/,
      use: [
        { loader: 'ts-loader' },
        { loader: require.resolve('@unzen/bundler/webpack-loader') },
      ],
    }],
  },
};
```

#### 抽出契約

- `import { UnzenServer } from '@unzen/server'`（alias可）またはnamespace importが必要
- `const server = new UnzenServer(...)` の直接初期化が必要
- `server.define(name, fn, options?)` はトップレベルのexpression statementに置く
- `name` は静的文字列、`fn` はinline arrow/function expressionかつ同期関数に限る
- 動的な名前、外部変数に入れた関数、async/generatorは位置付きbuild errorになる
- nestedな`.define()`と無関係なライブラリの`.define()`は誤変換を避けるため触らない
- クロージャの外部参照は抽出文字列には含まれない。関数は引数とsandbox組み込みだけで完結させる
- npm依存を関数へ含める場合は下記`bundle()`を使い、module whitelistを適用する

### npm依存のバンドル

```typescript
import { bundle } from '@unzen/bundler';

// npm 依存を含む関数をバンドル
const result = await bundle({
  code: `
    import { sortBy } from 'lodash';
    export function run(items) {
      return sortBy(items, ['name', 'age']);
    }
  `,
  allowedModules: ['lodash', 'lodash/*'],
});

console.log(result.code);    // バンドルされたコード（IIFE形式）
console.log(result.size);    // バイトサイズ
console.log(result.modules); // ['lodash']
```

## API

### `bundle(options): Promise<BundleResult>`

| オプション | 型 | 説明 |
|---|---|---|
| `code` | `string` | import文を含む関数コード |
| `allowedModules` | `string[]` | 許可モジュールパターン（例: `['lodash/*']`） |

| 結果 | 型 | 説明 |
|---|---|---|
| `code` | `string` | バンドルされた自己完結型コード |
| `size` | `number` | バイトサイズ |
| `modules` | `string[]` | 検出されたモジュール名 |

### `checkModuleAllowed(moduleName, patterns): boolean`

モジュールがホワイトリストで許可されているかを確認する。Node.js 組み込みモジュールは常に `false` を返す。

### `isNodeBuiltin(name): boolean`

Node.js 組み込みモジュールかどうかを判定する。`node:` プレフィックスにも対応している。

### `checkForbiddenApis(code): string[]`

コード内の禁止API使用を検出する。違反がなければ空配列を返す。

### `DEFAULT_ALLOWED_MODULES`

デフォルトの許可モジュールリスト: `lodash`, `date-fns`, `validator`, `marked`, `json-schema`

### `transformUnzenDefinitions(source, fileName)`

adapter共通のAST変換。変更がなければ`null`、変更時は`code`、`map`、抽出した
`definitions`（name/line/column）を返す。

### `unzenVitePlugin(options?)`

Vite/Rollup互換のpre-transform pluginを返す。標準ではJS/TS系拡張子だけを処理し、
`node_modules`、virtual module、query付きrequestを除外する。`include` / `exclude`には
単一または複数の正規表現を指定できる。

### `@unzen/bundler/webpack-loader`

ESMとCommonJSの両方で公開するwebpack loader。変換結果とsource mapをwebpackの
loader callbackへ渡す。

## バンドルパイプライン

1. ソースコードから import 文を抽出する（静的プリチェック）
2. 各 import をホワイトリスト + Node.js 組み込みブロックリストで検証する
3. esbuild でバンドルする（IIFE形式、ES2018ターゲット、ブラウザプラットフォーム）
   - `onResolve` プラグインで全モジュール解決を検証する
4. バンドル出力に禁止APIがないかスキャンする
5. run() 関数を抽出可能な形に変換する

## テスト

```bash
# バンドラーテストのみ
npx vitest run packages/bundler/tests/

# 全テスト
npx vitest run
```

## 制限事項

- 禁止API検出は正規表現ベースのヒューリスティック。動的に構築された API 呼び出し（例: `window['fe'+'tch']`）は検出できない
- ランタイムのサンドボックス（QuickJS）がこれらの API を提供しないことが最終的な安全保証となる
- バンドルされた npm モジュールは事前にインストールされている必要がある
- compile-time抽出はinline関数を文字列化するが、クロージャ値やimportを自動bundleしない

---

**最終更新**: 2026年8月
