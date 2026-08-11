# unzen core 設計書

## 1. コンセプト

サーバーサイドで定義した計算関数を、訪問者のブラウザで実行するフレームワーク。
訪問者が自分自身のために必要とする計算を、サーバーではなくブラウザ側で処理する。

### 1.1 基本モデル

```
従来:
  訪問者 → サーバーAPI → サーバーで計算 → 結果返却

unzen:
  訪問者 → ブラウザ内 QuickJS/MoonBit (Wasm) で計算 → 結果をそのまま利用
          （失敗時のみサーバーにフォールバック）
```

### 1.2 設計原則

- **自己消費**: 訪問者は自分が必要とする機能だけを実行する。他人のための計算はしない
- **透過性**: 開発者は関数を定義するだけ。実行場所の切り替えはフレームワークが自動で行う
- **安全性**: QuickJSサンドボックスにより、外部接続・DOM操作・副作用を完全に遮断する
- **フォールバック**: ブラウザ実行が不可能な場合、同じ関数をサーバーで実行する

---

## 2. アーキテクチャ

### 2.1 コンポーネント構成

```
┌─────────────────────────────────────────────────┐
│  サイトオーナーのサーバー                          │
│  ┌────────────────────────────────────────────┐ │
│  │  Server SDK (@unzen/server)                 │ │
│  │  - 関数定義の登録                            │ │
│  │  - 関数コードの配信エンドポイント              │ │
│  │  - フォールバック実行エンジン (QuickJS on Node) │ │
│  └──────────────────┬─────────────────────────┘ │
└─────────────────────┼───────────────────────────┘
                      │ 関数コード配信 (HTTP)
                      ▼
┌─────────────────────────────────────────────────┐
│  訪問者のブラウザ                                 │
│  ┌────────────────────────────────────────────┐ │
│  │  Client SDK (@unzen/client)                 │ │
│  │  - 関数コードの取得・キャッシュ               │ │
│  │  - ランタイム選択 (QuickJS / MoonBit)        │ │
│  │  ┌──────────────────────────────────────┐  │ │
│  │  │  Web Worker                          │  │ │
│  │  │  ┌──────────────┐ ┌──────────────┐  │  │ │
│  │  │  │ QuickJS Wasm │ │ MoonBit Wasm │  │  │ │
│  │  │  │ (JS関数実行)  │ │ (高速計算)   │  │  │ │
│  │  │  └──────────────┘ └──────────────┘  │  │ │
│  │  └──────────────────────────────────────┘  │ │
│  └────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────┘
```

### 2.2 SDK API設計

#### サーバー側 (関数定義)

```typescript
// server.ts - サーバー側で関数を定義
import { UnzenServer } from '@unzen/server';

const unzen = new UnzenServer();

// JavaScript関数をブラウザ委任として登録
// 第1引数: 関数名、第2引数: ブラウザで実行される関数コード (文字列化される)
unzen.define('spamCheck', (text: string) => {
  const patterns = [/viagra/i, /casino/i, /lottery/i];
  return patterns.some(p => p.test(text));
});

// MoonBit関数の登録 (事前コンパイル済みWasmバイナリを指定)
unzen.defineMoonBit('heavyCalc', {
  wasmPath: './heavy_calc.wasm',  // MoonBitからコンパイル済み
  entryPoint: 'calculate',
});

// Express/Hono等のミドルウェアとして関数コード配信エンドポイントを追加
app.use('/unzen', unzen.middleware());
```

#### クライアント側 (関数実行)

```html
<!-- サイトのHTML -->
<script src="https://cdn.example.com/@unzen/client.js"></script>
<script>
  // 初期化: サーバーから関数定義を取得し、QuickJS Wasmをロード
  const unzen = new UnzenClient({ endpoint: '/unzen' });

  // 関数呼び出し: ブラウザ内のQuickJS Wasmで実行される
  // サーバーには一切リクエストしない
  const isSpam = await unzen.call('spamCheck', commentText);

  // MoonBit関数の呼び出し: コンパイル済みWasmを直接実行
  const result = await unzen.call('heavyCalc', inputData);
</script>
```

#### フォールバック

```typescript
// Client SDK内部のフォールバックロジック
// ブラウザ実行が失敗した場合、自動的にサーバーAPIにリクエストする
async call(name: string, ...args: any[]) {
  try {
    // 1. ブラウザ内Wasm実行を試行
    return await this.worker.execute(name, args);
  } catch (e) {
    // 2. Wasm実行失敗時: サーバーにフォールバック
    //    - QuickJS未対応ブラウザ
    //    - メモリ不足
    //    - タイムアウト
    console.warn(`[unzen] Browser execution failed, falling back to server: ${e.message}`);
    return await fetch(`${this.endpoint}/exec/${name}`, {
      method: 'POST',
      body: JSON.stringify({ args }),
    }).then(r => r.json());
  }
}
```

### 2.3 関数コード配信フロー

```
1. 訪問者がサイトにアクセス
2. Client SDK が /unzen/manifest を取得し schema 検証 (関数一覧 + メタデータ)
3. 必要に応じて QuickJS Wasm ランタイムをダウンロード (初回のみ、キャッシュ)
4. 関数コードを取得 (Service Worker でキャッシュ可能)
5. Web Worker 内で QuickJS を初期化
6. 訪問者のアクション時に関数を実行
```

### 2.4 2つのランタイム

#### QuickJS ランタイム (JavaScript関数用)

- Wasmにコンパイルされた軽量JSエンジンである (Bellard作)
- 任意のJavaScript関数を実行できる
- サンドボックスにより安全性を担保する
- バイナリサイズ: ~505KB (gzip: ~150KB)
- 性能: V8 JIT比で低速だが、50ms以内の短時間関数には十分である
  - V8はJITコンパイルにより高速だが、QuickJSはインタプリタで実行する
  - 短時間関数 (バリデーション、フィルタリング等) では体感差はない
  - 起動が高速 (コールドスタート ~10-25ms) なのが利点である
- メモリ: ベースライン ~2-4MB (V8の ~30MB と比較して軽量である)

#### MoonBit ランタイム (高性能計算用)

- MoonBit言語で書かれた関数を直接Wasmにコンパイルする
- wasm-gc バックエンドにより、GCはブラウザVMに委譲する (バイナリにGCランタイム不含)
- QuickJSより大幅に高速である (Rustの~10%以内、ネイティブJSの数倍)
  - ベンダーベンチマーク: fib(46) でRust 160ms vs MoonBit 177ms
  - イテレータ処理で plain JS の ~7.7倍の速度が出る
  - ※ ベンダー提供の数値であり、独立ベンチマークは未確認である
- バイナリサイズ: 極小 (fib関数: 253bytes, HTTP component: 27KB)
- ブラウザ要件: wasm-gc 対応 (Chrome 119+, Firefox 120+, Safari 18.2+)
- Wasmサンドボックスにより安全性を担保する (メモリ隔離、外部アクセス不可)
- 用途: 数値計算、暗号処理、データ変換などの計算集約型タスクに適している

#### 使い分け

| 観点 | QuickJS | MoonBit |
|------|---------|---------|
| 言語 | JavaScript (既存コード流用可) | MoonBit (要学習、v1.0は2026予定) |
| 初回ロード | ~150KB gzip (ランタイム) | 関数ごとに数百B〜数十KB |
| 実行速度 | 短時間関数に十分 | Rustに近い高速実行 |
| ブラウザ要件 | Wasm対応のみ (ほぼ全ブラウザ) | wasm-gc対応 (2024年以降のブラウザ) |
| 適用場面 | 手軽にJS関数を委任 | 性能が重要な計算処理 |

### 2.5 MoonBit 関数の具体的ワークフロー

#### MoonBit コード例 (.mbt)

```moonbit
// stats.mbt - 統計計算関数
// unzen で委任する関数は純粋関数であること (副作用なし、外部状態参照なし)

pub fn mean(data : Array[Double]) -> Double {
  let n = data.length()
  if n == 0 { return 0.0 }
  let mut sum = 0.0
  for x in data {
    sum = sum + x
  }
  sum / n.to_double()
}

pub fn std_dev(data : Array[Double]) -> Double {
  let n = data.length()
  if n < 2 { return 0.0 }
  let avg = mean(data)
  let mut variance_sum = 0.0
  for x in data {
    let diff = x - avg
    variance_sum = variance_sum + diff * diff
  }
  let variance = variance_sum / (n - 1).to_double()
  variance.sqrt()
}
```

#### moon.pkg.json (エクスポート設定)

```json
{
  "link": {
    "wasm-gc": {
      "exports": ["mean", "std_dev"]
    }
  }
}
```

#### ビルド・登録

```bash
# MoonBitプロジェクト作成
moon new stats-functions
cd stats-functions

# ビルド (wasm-gc ターゲット)
moon build --target wasm-gc --release
# → target/wasm-gc/release/build/lib/lib.wasm (数百B〜数十KB)

# サーバーSDKに登録
cp target/wasm-gc/release/build/lib/lib.wasm ./server/functions/stats.wasm
```

#### サーバーSDKでの登録

```typescript
// MoonBit Wasm関数をサーバーSDKに登録
export const stdDev = unzen.defineMoonBit('stdDev', {
  wasmPath: './functions/stats.wasm',
  entryPoint: 'std_dev',
});
```

#### ブラウザでの実行フロー

```
1. Client SDK が /unzen/manifest を取得 → stats.wasm のURLを取得
2. stats.wasm をダウンロード (数百B〜数十KB、Service Workerでキャッシュ)
3. WebAssembly.instantiateStreaming で wasm-gc モジュールをロード
   （※ 現行実装は fetch → compile → instantiate。instantiateStreaming は将来設計）
4. unzen.call('stdDev', data) → Wasmエクスポート関数を直接呼び出し
```

### 2.6 データマーシャリング

JavaScriptのデータとWasm関数間のデータ受け渡し方法。

> **注 (2026-08-11)**: 現行実装（Phase 3）の契約は以下。
> 実測・実装の最新情報は `docs/ARCHITECTURE.md` の
> 「MoonBit の String / Array interop」節を参照。
>
> - ABI 省略時: `number` / `boolean` / `bigint` / `string` のスカラーのみ
>   （`string` は `WebAssembly.compile(bytes, { builtins: ['js-string'],
>   importedStringConstants: '_' })` による JS String Builtins 経由。
>   ブラウザ要件: Chromium / Firefox は動作確認済み。Safari は wasm-gc が
>   18.2+、JS String Builtins が 26.2+（本プロジェクトでは Safari 未検証））
> - `importedStringConstants` の既定値は `_`。MoonBit 側の
>   `imported-string-constants` と同じ namespace を client option で指定でき、
>   `null` なら option を省略する。選択した namespace は文字列定数用に予約され、
>   同 namespace の function import 等とは併用できない
> - 明示 ABI 指定時: `i32[]` / `f64[]` の数値配列を標準
>   `unzen_array_i32_*` / `unzen_array_f64_*` bridge で相互コピー。
>   `i32[]` は符号付き32 bit整数に限定。入力合計/戻り値それぞれ
>   10万要素を上限とする
> - 非対応: `object`。ABI なしの plain JS 配列も従来どおり拒否
> - ロード: `fetch → validate → WebAssembly.compile →
>   WebAssembly.instantiate`（`instantiateStreaming` は未使用）
> - `defineMoonbit(..., { abi })` で登録した `moonbitAbi` をマニフェストから
>   main/worker executor へ伝播し、引数数・型・サイズ・bridge export を検証する
> - main/worker executor は module 準備前に引数、ABI、`signal`、export 名、
>   expected hash を一度だけ読み取って所有し、worker の inline `ArrayBuffer` も
>   同時点でコピーする。空 URL と不正な execution option は副作用前に拒否する

#### QuickJS ランタイムの場合

QuickJSは完全なJSエンジンであるため、マーシャリングは不要。
引数はJSON文字列としてQuickJSに渡し、QuickJS内部でパースされる。
client / Mock executor は非同期初期化やqueue登録より前に最大128件の引数を index 順に読み、
JSON round-trip した所有 snapshot を作る。per-call option bag と `signal` はその前に一度だけ
検証・snapshot する。循環値や BigInt は `UnzenFunctionError` で拒否する。

```typescript
// Client SDK内部の実装イメージ
// QuickJS側では通常のJavaScriptとして引数を受け取る
const result = quickjs.evalCode(`
  const fn = ${functionCode};
  fn(${JSON.stringify(args)});
`);
```

#### MoonBit ランタイムの場合

MoonBit wasm-gcは `externref` を通じてJSオブジェクトを受け渡し可能。
ただし、unzenでサポートするデータ型を限定し、明示的な変換レイヤーを設ける。

**サポートするデータ型**:

| JavaScript型 | MoonBit型 | 変換方法 |
|-------------|-----------|---------|
| `number` | `Int`, `Double` | Wasm ABI直接渡し (i32, f64) |
| `boolean` | `Bool` | i32 (0/1) |
| `string` | `String` | wasm-gc JS String Builtins (externref) |
| 32 bit整数の `number[]` | `Array[Int]` | `i32[]` ABI + 標準 bridge でコピー |
| `number[]` | `Array[Double]` | `f64[]` ABI + 標準 bridge でコピー |
| `object` | - | 非対応 |

> **性能注意**: 数値配列は JS と wasm-gc の間で全要素を往復コピーするため、
> 小さな計算ではマーシャリングコストが MoonBit の速度上の利点を上回る可能性がある。

**変換フロー**:

```
1. unzen.call('stdDev', [1.0, 2.0, 3.0])
2. Client SDK がマニフェストから引数型情報を取得
3. 型に応じた変換: number[] → MoonBit Array[Double] (標準 bridge 経由)
4. Wasmエクスポート関数を呼び出し
5. 戻り値を JavaScript 型に逆変換
```

**マニフェストでの型情報**:

```json
{
  "functions": {
    "stdDev": {
      "runtime": "moonbit",
      "codeUrl": "/unzen/code/stdDev?v=1&h=sha256%3Adef456...",
      "exportName": "std_dev",
      "moonbitAbi": { "params": ["f64[]"], "result": "scalar" }
    }
  }
}
```

#### MoonBit モジュール単位の登録

1つのWasmファイルに複数の関数が含まれる場合、モジュール単位で登録できる:

```typescript
// 1つのWasmファイルから複数関数を登録
const stats = unzen.defineMoonBitModule('stats', {
  wasmPath: './functions/stats.wasm',
  functions: {
    mean: { params: ['Array[Double]'], returns: 'Double' },
    stdDev: { params: ['Array[Double]'], returns: 'Double' },
  },
});

// クライアント側: 同一Wasmインスタンスを共有して呼び出し
await unzen.call('stats.mean', data);
await unzen.call('stats.stdDev', data);
// → stats.wasm は1回だけロード・インスタンス化される
```

### 2.7 エラーハンドリング

#### ユーザー定義関数内のエラー

関数内部で発生したエラーは、フォールバックの対象にはならず、呼び出し元に伝播する:

```typescript
// 関数内部のエラー → 呼び出し元に throw される (フォールバックしない)
try {
  const result = await unzen.call('validate', input);
} catch (e) {
  if (e instanceof UnzenFunctionError) {
    // ユーザー定義関数が throw したエラー
    console.error('関数エラー:', e.message);
  } else if (e instanceof UnzenRuntimeError) {
    // ランタイムエラー (タイムアウト、メモリ不足) → フォールバック済みでも失敗
    console.error('ランタイムエラー:', e.message);
  }
}
```

**エラー分類**:

| エラー種別 | フォールバック | 例 |
|-----------|-------------|-----|
| `UnzenRuntimeError` | する | タイムアウト、メモリ不足、Wasmロード失敗 |
| `UnzenFunctionError` | しない | ユーザー関数内の throw、型エラー |
| `UnzenNetworkError` | - | マニフェスト取得失敗、フォールバックAPI失敗 |

fallback API は最大128引数の JSON transport とし、client/server の両側で request
shape を検証する。client は response の `result` / `error` envelope も実行時検証し、
malformed JSON、redirect、rate limit、5xx を `UnzenNetworkError` として fail closed にする。
公開 `execute` API も同じ128引数上限を適用し、manifest fetch より前に request field と
top-level 引数 slot を一度だけ読み取って浅く snapshot する。不正な request は browser / server
のどちらも開始せず `UnzenFunctionError`（diagnostics は `function_failed`）で拒否する。

#### MoonBit のエラー

MoonBitのパニック (`abort`) はWasmトラップとして発生し、`UnzenFunctionError` に変換される。

### 2.8 関数の制約: 純粋関数のみ

unzen で委任できる関数は**純粋関数**に限定される:

```typescript
// OK: 純粋関数 - 入力のみに依存し、同じ入力には同じ出力を返す
unzen.define('validate', (email: string) => {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
});

// NG: 外部状態を参照する関数 - ブラウザにはDBがないため動作しない
unzen.define('checkUser', (id: string) => {
  return db.query('SELECT * FROM users WHERE id = ?', [id]);  // ERROR
});

// NG: クロージャで外部スコープを参照 - 文字列化時にスコープが失われる
const config = { maxLen: 100 };
unzen.define('check', (text: string) => {
  return text.length <= config.maxLen;  // ERROR: config is undefined
});
```

制約の理由:
- 関数コードはサーバーで**文字列化**されてブラウザに配信される
- ブラウザ側ではクロージャのスコープ、外部モジュール、DB接続等にアクセスできない
- この制約はMoonBitでは自然に満たされる (Wasm関数は本質的に純粋)

**注意: `Function.prototype.toString()` とビルド時抽出**:
- JS関数の文字列化は `Function.prototype.toString()` に依存しており、トランスパイラ出力やminifyで壊れる可能性がある
- `@unzen/bundler` のVite plugin / webpack loaderは、`UnzenServer` importと
  `const` instanceをASTで確認したトップレベルinline同期関数を、型注釈を除去して
  `defineRaw()`へコンパイル時変換する（source map付き）
- Vite pluginの`declarationFile`を指定すると、抽出したsignatureから
  `UnzenFunctions`とtyped `UnzenClient` aliasをbuild assetとして自動生成する
- 抽出時はTypeScriptのsymbol/scopeを使って、関数外のruntime binding、禁止global、
  dynamic import、外部context、入力/globalへの代入、乱数・現在時刻への直接依存を
  位置付きbuild errorにする。local working stateへの代入は許可する
- 型annotationは実行時に消えるため、type-only importやlocal typeは純粋性検査の対象外
- MVP段階では、関数定義を文字列リテラルとして渡す代替APIも提供する:
  ```typescript
  // 代替: 文字列リテラルで関数を定義 (トランスパイラに影響されない)
  unzen.defineRaw('spamCheck', `
    function(text) {
      const patterns = [/viagra/i, /casino/i, /lottery/i];
      return patterns.some(p => p.test(text));
    }
  `);
  ```

### 2.9 関数バージョニングとキャッシュ

```
マニフェスト (/unzen/manifest):
{
  "functions": {
    "spamCheck": {
      "runtime": "quickjs",
      "hash": "sha256:abc123...",   // 関数コードのハッシュ
      "version": 3,
      "codeUrl": "/unzen/code/spamCheck?v=3&h=sha256%3Aabc123..."
    },
    "stdDev": {
      "runtime": "moonbit",
      "hash": "sha256:def456...",   // Wasmバイナリのハッシュ
      "version": 1,
      "codeUrl": "/unzen/code/stdDev?v=1&h=sha256%3Adef456..."
    }
  }
}
```

キャッシュ戦略:
1. **マニフェスト**: runtime schema を検証して prototype-safe な snapshot にコピーし、ETag で条件付きリクエストを行う
2. **SDK 検証**: JavaScript / Wasm の生バイトを manifest の SHA-256 と照合し、一致後だけ decode / compile / cache する
3. **関数コード/Wasm**: version + SHA-256 の URL でイミュータブルキャッシュを使用する (`Cache-Control: immutable`)
4. **Service Worker**: SHA-256 を再検証した同一 origin の versioned code/Wasm のみ CacheStorage に永続化する
5. **更新フロー**: サーバー側で関数を変更 → ハッシュが変わる → 次回マニフェスト取得時に検出する

---

## 3. QuickJS サンドボックス設計

### 3.1 多層サンドボックス構造

```
┌─────────────────────────────────────────────┐
│          ホストブラウザ環境                   │
│  ┌───────────────────────────────────────┐  │
│  │         Web Worker コンテキスト          │  │
│  │  - CSP: script-src 'none'              │  │
│  │  - No DOM access                       │  │
│  │  ┌─────────────────────────────────┐  │  │
│  │  │     WebAssembly インスタンス      │  │  │
│  │  │  - Linear memory: 16MB固定        │  │  │
│  │  │  - No mutable globals export      │  │  │
│  │  │  - Indirect call table 検証       │  │  │
│  │  │  ┌─────────────────────────┐   │  │  │
│  │  │  │    QuickJS ランタイム    │   │  │  │
│  │  │  │  ┌─────────────────┐   │   │  │  │
│  │  │  │  │  ユーザーコード    │   │   │  │  │
│  │  │  │  │  (JavaScript)    │   │   │  │  │
│  │  │  │  │                  │   │   │  │  │
│  │  │  │  │  許可API:        │   │   │  │  │
│  │  │  │  │  • JSON          │   │   │  │  │
│  │  │  │  │  • Math          │   │   │  │  │
│  │  │  │  │  • Array/Object  │   │   │  │  │
│  │  │  │  │  • Promise       │   │   │  │  │
│  │  │  │  │                  │   │   │  │  │
│  │  │  │  │  禁止API:        │   │   │  │  │
│  │  │  │  │  • eval/Function │   │   │  │  │
│  │  │  │  │  • Date (高精度) │   │   │  │  │
│  │  │  │  │  • fetch/XHR     │   │   │  │  │
│  │  │  │  │  • setTimeout    │   │   │  │  │
│  │  │  │  └─────────────────┘   │   │  │  │
│  │  │  └─────────────────────────┘   │  │  │
│  │  └─────────────────────────────────┘  │  │
│  └───────────────────────────────────────┘  │
└─────────────────────────────────────────────┘
```

4層の隔離:
1. **Web Worker**: DOM・メインスレッドから隔離する
2. **WebAssembly**: メモリ空間を完全に分離する
3. **QuickJS**: JS実行環境をホストJSから隔離する
4. **API制限**: 危険なAPIを初期化時に削除する

### 3.2 QuickJS Wasm ビルド

```bash
# 環境要件: Emscripten 3.1.45+

QUICKJS_VERSION="2024-01-13"

# Emscriptenでビルド
emcc -O3 -flto \
  libquickjs.a \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s ENVIRONMENT=web,worker \
  -s FILESYSTEM=0 \
  -s ALLOW_MEMORY_GROWTH=0 \
  -s INITIAL_MEMORY=16MB \
  -s STACK_SIZE=1MB \
  -o quickjs.js

# 出力: quickjs.js + quickjs.wasm
# サイズ: ~505KB (gzipped: ~150KB)
# 起動時間 (コールドスタート): ~10-25ms
```

### 3.3 リソース制限

```c
// quickjs_sandbox.c - サンドボックス設定

#define MAX_MEMORY (16 * 1024 * 1024)   // 16MB
#define MAX_STACK_SIZE (256 * 1024)      // 256KB
#define MAX_EXEC_TIME_MS 50              // 50ms

// インタラプトハンドラ: 実行時間超過時に中断
// タイミング攻撃対策として最低5ms間隔でチェック
static int interrupt_handler(JSRuntime *rt, void *opaque) {
    ExecutionContext *ctx = (ExecutionContext *)opaque;
    uint64_t current = get_time_ms();
    if (current - ctx->last_check < 5) return 0;
    ctx->last_check = current;
    if (current - ctx->start_time > ctx->max_time) {
        ctx->interrupted = 1;
        return 1;  // 中断
    }
    return 0;
}

// 安全なコンテキスト初期化
JSContext* create_sandbox_context() {
    JSRuntime *rt = JS_NewRuntime();
    JS_SetMemoryLimit(rt, MAX_MEMORY);
    JS_SetMaxStackSize(rt, MAX_STACK_SIZE);
    JSContext *ctx = JS_NewContext(rt);

    JSValue global = JS_GetGlobalObject(ctx);

    // 危険なAPIを削除
    JS_DeletePropertyStr(ctx, global, "eval");
    JS_DeletePropertyStr(ctx, global, "Function");

    // Date精度を1秒に制限 (タイミング攻撃対策)
    // __low_res_time__ はWasmインスタンス化時にインポート関数として提供される低精度タイムソース
    const char *date_shim = "Date.now = function() { "
        "return Math.floor(__low_res_time__() / 1000) * 1000; };";
    JS_Eval(ctx, date_shim, strlen(date_shim), "<shim>", 0);

    JS_FreeValue(ctx, global);
    return ctx;
}
```

### 3.4 セキュリティ対策

| 脅威 | 対策 | 検証方法 |
|-----|------|---------|
| サンドボックス突破 | Wasmメモリ隔離 + APIホワイトリスト | ペネトレーションテスト |
| タイミング攻撃 | Date精度制限 (1秒) + 定数時間比較 | 統計的検定 |
| ReDoS | 正規表現の実行時間制限 | パターンテスト |
| メモリ枯渇 | 16MB上限 + OOMハンドラ | メモリ圧力テスト |
| スタックオーバーフロー | 256KB制限 | 再帰テスト |
| 情報漏洩 | グローバルオブジェクト最小化 | プロパティ列挙テスト |
| コードインジェクション | eval/Function削除 + 入力検証 | ファジングテスト |

### 3.5 MoonBit Wasm のセキュリティ

MoonBitで書かれた関数はWasmにネイティブコンパイルされるため、
QuickJSとは異なるサンドボックスモデルを持つ:

- **Wasmレベルの隔離**: メモリ空間が完全に分離される (QuickJSと同等)
- **外部接続不可**: Wasm仕様によりネットワークアクセスができない
- **インポート制限**: ホストから提供する関数を最小限に制限する
- **ランタイム不要**: コンパイル済みWasmを直接実行するため、攻撃面が小さい

---

## 4. 外部接続禁止ポリシー

### 4.1 禁止API

| API | 理由 |
|-----|------|
| fetch / XMLHttpRequest | HTTPリクエスト禁止 |
| WebSocket | リアルタイム通信禁止 |
| navigator.sendBeacon | ビーコン送信禁止 |
| WebRTC DataChannel | P2P通信禁止 |

### 4.2 禁止の根拠

たとえ自己消費モデルであっても、サイトオーナーが配信する関数コードに
悪意がある場合、訪問者のブラウザを踏み台にできてしまう。
外部接続を禁止することで、この攻撃ベクトルを根本的に排除する。

### 4.3 許可される処理

純粋計算のみを許可する: 入力 → 計算 → 出力。副作用はない。

---

## 5. フォールバック設計

### 5.1 フォールバック条件

| 条件 | 動作 |
|------|------|
| QuickJS Wasm 未対応ブラウザ | サーバーで実行 |
| Web Worker 未対応 | サーバーで実行 |
| 実行タイムアウト (50ms超過) | サーバーで実行 |
| メモリ不足 | サーバーで実行 |
| Wasm ロード失敗 | サーバーで実行 |

### 5.2 サーバー側フォールバック実行

```typescript
// サーバー側: QuickJS (Node.js用) で同じ関数を実行
// ブラウザと同一のサンドボックス制約を適用
import { QuickJSRuntime } from '@unzen/server';

app.post('/unzen/exec/:name', async (req, res) => {
  const { name } = req.params;
  const { args } = req.body;
  const fn = unzen.getFunction(name);

  // サーバー側QuickJSで実行 (同一サンドボックス)
  const result = await QuickJSRuntime.execute(fn.code, args, {
    timeout: 50,
    memoryLimit: 16 * 1024 * 1024,
  });

  res.json(result);
});
```

### 5.3 MoonBit 関数のフォールバック

MoonBit関数はサーバー側にMoonBitランタイムがないため、フォールバック戦略が異なる:

- **デフォルト**: MoonBit関数はフォールバックしない。ブラウザ実行に失敗した場合は `UnzenRuntimeError` を送出する
- **オプション**: 開発者がフォールバック用のJS実装を明示的に提供できる:

```typescript
export const stdDev = unzen.defineMoonBit('stdDev', {
  wasmPath: './stats.wasm',
  entryPoint: 'std_dev',
  // フォールバック用JS実装 (任意)
  fallback: (data: number[]) => {
    const n = data.length;
    if (n < 2) return 0;
    const avg = data.reduce((s, x) => s + x, 0) / n;
    const variance = data.reduce((s, x) => s + (x - avg) ** 2, 0) / (n - 1);
    return Math.sqrt(variance);
  },
});
```

wasm-gc 未対応ブラウザ (2024年以前) ではフォールバック用JS実装がないMoonBit関数は利用できない。
QuickJS関数への切り替えを検討すること。

---

## 6. デバッグ・開発体験 (DX)

### 6.1 開発モード

```typescript
// 開発時: ブラウザ実行をスキップし、常にサーバーで実行
// → ブレークポイント、console.log等の通常のデバッグ手法が使える
const unzen = new UnzenClient({
  endpoint: '/unzen',
  mode: 'development',  // 常にサーバーフォールバック
});
```

### 6.2 実行モードの切り替え

| モード | 動作 | 用途 |
|--------|------|------|
| `development` | 常にサーバーで実行 | デバッグ、ブレークポイント |
| `production` | ブラウザ優先 + フォールバック | 本番運用 |
| `browser-only` | ブラウザのみ (フォールバックなし) | テスト、ベンチマーク |

`UnzenClient` は constructor option を component 生成前に検証し、選択した custom executor の
method と設定値を一度だけ snapshot する。endpoint の前後空白・末尾 slash は route 結合前に
正規化し、不正な mode / worker URL / executor shape は同期的に拒否する。

### 6.3 診断情報

```typescript
// 各関数呼び出しの実行情報を取得可能
const result = await unzen.call('spamCheck', text, { diagnostics: true });
// result.value: 関数の戻り値
// result.executedOn: 'browser' | 'server'
// result.runtime: 'quickjs' | 'moonbit'
// result.durationMs: 実行時間
// result.cached: 関数コードがキャッシュから取得されたか
```

---

## 7. 開発ロードマップ

### Phase 1: 基本動作 (MVP)
- [x] QuickJS Wasm ビルドと Web Worker での実行
- [x] サーバーSDK: 関数定義・マニフェスト配信エンドポイント
- [x] クライアントSDK: 関数取得・実行
- [x] フォールバック: サーバー側実行
- [x] 開発モード (常時サーバー実行)

### Phase 2: MoonBit対応・キャッシュ
- [x] MoonBit wasm-gc ランタイム統合
- [x] Service Worker による関数コード・Wasmキャッシュ
- [x] ハッシュベースのバージョニングと差分検出
- [x] wasm-gc / JS String Builtins 未対応ブラウザの検出（安定した runtime error。MoonBit は server fallback なし）

### Phase 3: DX向上
- [x] ビルドツール統合 (Vite plugin / webpack loader + 共通AST変換)
- [x] TypeScript型定義の自動生成 (Vite build asset + typed UnzenClient schema)
- [x] 診断情報API (実行場所・時間の可視化)
- [x] 純粋関数チェッカー (symbol/scopeベースの定義時静的解析)
- [x] バンドル後禁止APIチェッカー (AST + symbol/scopeベースのglobal参照解析)

---

**ドキュメントバージョン**: 3.0
**作成日**: 2026年2月
**前バージョンからの変更**: 自己消費モデルへ全面移行。Dispatcher、PBFT合意、Reward System、分散アーキテクチャを削除。MoonBitランタイム追加。
