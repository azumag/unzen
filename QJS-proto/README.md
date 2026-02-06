# unzen (QJS-proto)

サーバーサイドの計算関数をブラウザ側に委任するフレームワーク。
QuickJS (Wasm) または MoonBit (Wasm) サンドボックスで安全に実行し、サーバーコストを削減する。

> **ステータス**: 設計・技術検証段階。APIは未確定であり、変更される可能性があります。

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

## 基本的な使い方 (API設計例)

```bash
npm install @unzen/server @unzen/client
```

```typescript
// server.ts - サーバー側
import { UnzenServer } from '@unzen/server';

const unzen = new UnzenServer();

// 関数を定義: ブラウザで実行される
export const spamCheck = unzen.define('spamCheck', (text: string) => {
  const patterns = [/viagra/i, /casino/i, /lottery/i];
  return patterns.some(p => p.test(text));
});

// ミドルウェアを追加 (Express/Hono等)
app.use('/unzen', unzen.middleware());
```

```html
<!-- クライアント側 -->
<script src="@unzen/client.js"></script>
<script>
  const unzen = new UnzenClient({ endpoint: '/unzen' });

  // ブラウザ内で実行される。失敗時は自動でサーバーにフォールバック
  const isSpam = await unzen.call('spamCheck', commentText);
</script>
```

## 2つのランタイム

| | QuickJS (JS) | MoonBit (Wasm) |
|---|---|---|
| 言語 | JavaScript | MoonBit |
| 実行方式 | Wasm上でJSを解釈実行 | wasm-gc にネイティブコンパイル |
| サイズ | ~150KB (gzip) + 関数コード | 関数ごとに数百B〜数十KB |
| 性能 | 短時間関数に十分 (50ms以内) | Rustに近い高速実行 |
| ブラウザ | ほぼ全ブラウザ | wasm-gc対応 (Chrome 119+, Firefox 120+, Safari 18+) |
| 用途 | 手軽にJS関数を委任 | 性能が重要な計算処理 |

### MoonBit の例

```moonbit
// stats.mbt - MoonBitで書いた統計関数 → Wasmにコンパイル
// pub fn で公開した関数がWasmエクスポートとなる
pub fn std_dev(data : Array[Double]) -> Double {
  let n = data.length()
  if n < 2 { return 0.0 }
  let mut sum = 0.0
  for x in data { sum = sum + x }
  let avg = sum / n.to_double()
  let mut v = 0.0
  for x in data { let d = x - avg; v = v + d * d }
  (v / (n - 1).to_double()).sqrt()
}
```

```bash
moon build --target wasm-gc --release  # → 数百B〜数十KBのWasmバイナリ
```

```typescript
// サーバー側で登録: entryPoint は pub fn 名に対応
export const stdDev = unzen.defineMoonBit('stdDev', {
  wasmPath: './stats.wasm', entryPoint: 'std_dev',
});
```

## セキュリティ

関数はサンドボックス内で実行される:
- **外部接続禁止**: fetch, WebSocket, XHR 等は一切使えない
- **DOM アクセス不可**: Web Worker 内で隔離実行
- **リソース制限**: メモリ 16MB、実行時間 50ms 上限
- **純粋計算のみ**: 入力→計算→出力。副作用なし

## 想定ユースケース

- **フォームバリデーション**: 複雑なスキーマ検証をブラウザで
- **データ変換**: JSON/CSV/XMLの整形・変換
- **コンテンツフィルタリング**: スパム判定、NGワード検出
- **暗号化・ハッシュ**: SHA-256計算、チェックサム
- **軽量画像処理**: メタデータ抽出、サイズ計算

## アーキテクチャ

```
[サイトオーナー]
  npm install @unzen/server @unzen/client

  サーバー SDK              クライアント SDK
  ┌─────────────┐           ┌──────────────────┐
  │ 関数を定義   │──配信──→  │ Web Worker        │
  │ フォールバック│           │  └ QuickJS (Wasm) │
  │ 実行        │           │  └ MoonBit (Wasm) │
  └─────────────┘           └──────────────────┘
        ↑                          │
        └──失敗時フォールバック──────┘
```

## ドキュメント

詳細は `docs/` ディレクトリにまとめています。[ドキュメント一覧](docs/INDEX.md) を参照。

- [設計書](docs/design.md) - アーキテクチャ、サンドボックス、SDK設計
- [セキュリティ制約とユースケース](docs/use-cases-and-constraints.md) - 外部接続禁止ポリシー
- [学術参考文献](docs/references.md) - Wasm セキュリティ、サンドボックス関連論文

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

## ライセンス

未定 (MIT or AGPL を検討中)
