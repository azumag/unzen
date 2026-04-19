# サンプル関数リファレンス

unzen core の実践的なサンプル関数。サーバサイド計算をブラウザ sandbox に委譲する価値を実証する。

## なぜこれらの関数が必要か

従来のWebアプリでは以下の計算をサーバサイドで実行していた:
- **改ざん防止**: フォーム検証、価格計算はクライアントの devtools で改ざん可能
- **CPU負荷**: Markdownレンダリング等はサーバ CPU を消費
- **RTT遅延**: すべてのリクエストがサーバ往復 (~100ms) を必要とする

unzen core では QuickJS sandbox の特性（frozen prototypes, no eval, メモリ制限）により、
これらの計算を**安全にブラウザに委譲**できる。

---

## 1. `formValidate` — フォーム検証

### ユースケース
- サーバサイド検証が必要だったフォーム入力を sandbox で実行
- devtools による改ざん不可能（QuickJS sandbox は frozen prototypes）

### 入力
```typescript
type FormFields = {
  email?: string;       // RFC 5322 簡略パターン
  creditCard?: string;  // Luhn アルゴリズム (ISO/IEC 7812-1)
  phone?: string;       // 国際電話番号 (+XX-XXX-XXXX)
  password?: string;    // 最低8文字
};
```

### 出力
```typescript
type FormResult = {
  valid: boolean;
  errors: Record<string, string>;  // フィールド名 → エラーメッセージ
};
```

### 例
```javascript
// 全フィールド有効
await client.call('formValidate', {
  email: 'user@example.com',
  creditCard: '4111111111111111',
  phone: '+1-555-123-4567',
  password: 'MyP@ssw0rd!23',
});
// → { valid: true, errors: {} }

// 無効なメール
await client.call('formValidate', { email: 'bad-email' });
// → { valid: false, errors: { email: 'Invalid email format' } }
```

### 制約
- sandbox 実行: 16MB メモリ / 50ms タイムアウト以内
- クレジットカード番号はスペース・ハイフンを自動除去して検証
- パスワード強度は長さのみ（8文字以上）で判定

---

## 2. `calculatePrice` — 価格計算

### ユースケース
- 価格操作防止のためサーバで計算していた注文合計を sandbox で実行
- RTT削減: ~100ms → ~2ms

### 入力
```typescript
type Order = {
  items: Array<{
    name: string;
    price: number;
    quantity: number;
    weight?: number;  // kg, default 0.5
  }>;
  region: string;     // 'US-CA', 'JP', 'EU-DE', etc.
  discount?: {
    type: 'percentage' | 'fixed' | 'tiered';
    value?: number;   // percentage or fixed amount
  };
};
```

### 出力
```typescript
type PriceResult = {
  subtotal: number;
  discount: number;
  tax: number;
  shipping: number;
  total: number;
};
```

### 税率テーブル
| Region | Tax Rate |
|--------|----------|
| US-CA  | 7.25%    |
| US-NY  | 8%       |
| US-TX  | 6.25%    |
| JP     | 10%      |
| EU-DE  | 19%      |
| EU-FR  | 20%      |
| GB     | 20%      |
| その他 | 0%       |

### ティアード割引
| 小計     | 割引率 |
|----------|--------|
| $100+    | 5%     |
| $200+    | 10%    |
| $500+    | 15%    |

### 送料ルール
- 基本: $5 + $2/kg
- 国内 $100 以上: 無料
- 空注文: $0

### 例
```javascript
await client.call('calculatePrice', {
  items: [{ name: 'Widget', price: 100, quantity: 1 }],
  region: 'JP',
  discount: { type: 'percentage', value: 10 },
});
// → { subtotal: 100, discount: 10, tax: 9, shipping: 0, total: 99 }
```

---

## 3. `markdownToHtml` — Markdown → HTML 変換

### ユースケース
- SSR で行っていた Markdown レンダリングをクライアントに委譲
- サーバ CPU 負荷を分散

### 入力
```typescript
type Input = string; // Markdown テキスト
```

### 出力
```typescript
type Output = string; // HTML テキスト
```

### 対応構文
| Markdown             | HTML                          |
|----------------------|-------------------------------|
| `# Heading`          | `<h1>Heading</h1>`           |
| `## Heading`         | `<h2>Heading</h2>`           |
| `**bold**`           | `<strong>bold</strong>`       |
| `*italic*`           | `<em>italic</em>`            |
| `` `code` ``         | `<code>code</code>`          |
| `[text](url)`        | `<a href="url">text</a>`     |
| `![alt](url)`        | `<img src="url" alt="alt" />`|
| ```` ``` code ``` ````| `<pre><code>...</code></pre>` |
| ```` ```mermaid ... ``` ````| `<pre class="mermaid">...</pre>` |
| `- item`             | `<ul><li>item</li></ul>`      |
| `1. item`            | `<ol><li>item</li></ol>`      |
| 段落                 | `<p>...</p>`                  |

### セキュリティ
- すべてのインライン HTML は `&lt;`, `&gt;`, `&amp;`, `&quot;` にエスケープ
- コードブロック内も同様にエスケープ（XSS防止）
- `mermaid` フェンスも同様にエスケープし、安全な `<pre class="mermaid">` として出力

### 例
```javascript
await client.call('markdownToHtml', '# Hello **World**');
// → '<h1>Hello <strong>World</strong></h1>'
```

---

## 4. `textStats` — テキスト統計分析

### ユースケース
- サーバで計算していた可読性スコアを sandbox で実行
- 純粋計算なので sandbox に最適

### 入力
```typescript
type Input = string; // 分析対象テキスト
```

### 出力
```typescript
type TextStatsResult = {
  chars: number;              // 文字数
  words: number;              // 単語数
  sentences: number;          // 文数
  paragraphs: number;         // 段落数
  avgWordLength: number;      // 平均単語長
  syllables: number;          // 音節数（英語）
  readingTimeMinutes: number; // 読了時間（200wpm）
  fleschKincaidGrade: number; // FK可読性グレード（0以上）
};
```

### Flesch-Kincaid Grade Level
```
FK = 0.39 × (words / sentences) + 11.8 × (syllables / words) - 15.59
```
- 値が低い: 簡単な文章（小学校レベル）
- 値が高い: 難解な文章（大学レベル以上）
- 負の値は 0 にクランプ

### 例
```javascript
await client.call('textStats', 'The quick brown fox jumps over the lazy dog.');
// → { chars: 44, words: 9, sentences: 1, paragraphs: 1,
//      avgWordLength: 3.89, syllables: 11, readingTimeMinutes: 0.05,
//      fleschKincaidGrade: 2.31 }
```

---

## 5. `jsonSchemaValidate` — JSON Schema バリデーション

### ユースケース
- サーバで行っていた API リクエストの JSON Schema 検証をブラウザで実行
- 不正なリクエストがサーバーに到達する前にブロック

### 入力
```typescript
type Schema = {
  type?: 'string' | 'number' | 'integer' | 'boolean' | 'null' | 'array' | 'object';
  required?: string[];
  properties?: Record<string, Schema>;
  additionalProperties?: boolean;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  items?: Schema;
  minItems?: number;
  maxItems?: number;
};
type Data = unknown;
```

### 出力
```typescript
type ValidationResult = {
  valid: boolean;
  errors: string[];  // JSONPath 形式のエラーメッセージ (例: '$.user.age: expected type number')
};
```

### 例
```javascript
const schema = {
  type: 'object',
  required: ['name', 'email'],
  properties: {
    name: { type: 'string', minLength: 1 },
    email: { type: 'string', pattern: '^[^@]+@[^@]+$' },
    age: { type: 'integer', minimum: 0 },
  },
};

await client.call('jsonSchemaValidate', schema, { name: 'Alice', email: 'alice@example.com' });
// → { valid: true, errors: [] }

await client.call('jsonSchemaValidate', schema, { name: '' });
// → { valid: false, errors: ['$.name: string length 0 < minLength 1', '$.email: required field missing'] }
```

### 対応制約一覧
| 制約 | 対象型 | 説明 |
|------|--------|------|
| `type` | 全型 | JSON Schema Draft-07 の型チェック |
| `required` | object | 必須フィールド検証 |
| `properties` | object | プロパティごとの再帰バリデーション |
| `additionalProperties` | object | `false` で未定義プロパティを拒否 |
| `minLength` / `maxLength` | string | 文字列長の範囲検証 |
| `pattern` | string | 正規表現パターンマッチ |
| `enum` | 全型 | 許可値リスト |
| `minimum` / `maximum` | number | 数値範囲検証 |
| `items` | array | 配列要素の再帰バリデーション |
| `minItems` / `maxItems` | array | 配列長の範囲検証 |

---

## 6. `sortData` — マルチキーソート

### ユースケース
- ダッシュボード UI で頻出する大規模テーブルのソート処理
- ネットワーク往復なしで即座にソート結果を表示

### 入力
```typescript
type Data = Record<string, unknown>[];
type SortKeys = Array<{
  key: string;
  order: 'asc' | 'desc';
}>;
```

### 出力
```typescript
type Output = Record<string, unknown>[];  // ソート済み配列（元配列は変更されない）
```

### 例
```javascript
const data = [
  { name: 'Alice', dept: 'Engineering', salary: 120000 },
  { name: 'Bob', dept: 'Engineering', salary: 150000 },
  { name: 'Charlie', dept: 'Design', salary: 100000 },
];

await client.call('sortData', data, [
  { key: 'dept', order: 'asc' },
  { key: 'salary', order: 'desc' },
]);
// → [Charlie(Design,$100K), Bob(Eng,$150K), Alice(Eng,$120K)]
```

### 仕様
- 安定ソート（同値要素の相対順序を維持）
- undefined/null 値はソート末尾に配置
- 文字列は辞書順、数値は数値順で比較
- 空の sortKeys → 元の順序を維持

---

## 7. `levenshteinDistance` — テキスト類似度計算

### ユースケース
- ファジー検索、重複検出、タイポ修正候補の計算
- O(n*m) アルゴリズムでサーバー CPU を大量消費する典型例

### 入力
```typescript
type Input = [str1: string, str2: string];
```

### 出力
```typescript
type LevenshteinResult = {
  distance: number;    // 編集距離（0 = 完全一致）
  similarity: number;  // 類似度 (0.0〜1.0, 1.0 = 完全一致)
};
```

### アルゴリズム
- Wagner-Fischer 動的計画法
- O(min(n,m)) 空間最適化（1行バッファのみ使用）
- similarity = 1 - (distance / max(len(str1), len(str2)))

### 例
```javascript
await client.call('levenshteinDistance', 'kitten', 'sitting');
// → { distance: 3, similarity: 0.57 }

await client.call('levenshteinDistance', 'hello', 'hello');
// → { distance: 0, similarity: 1 }

await client.call('levenshteinDistance', '', 'abc');
// → { distance: 3, similarity: 0 }
```

---

## sandbox 制約

全関数は以下の制約の中で実行される:
- **メモリ**: 16MB 上限
- **セキュリティ**: `eval()`, `Function()` 無効化、prototype frozen

### タイムアウト階層

| Tier | Timeout | 対象関数 |
|------|---------|----------|
| default | 50ms | formValidate, calculatePrice, textStats |
| medium | 500ms | jsonSchemaValidate, sortData, levenshteinDistance, markdownToHtml |
| heavy | 2,000ms | (将来の大規模データ処理、暗号ハッシュ向け) |

```typescript
// per-function timeout は defineRaw の第3引数で指定
unzen.defineRaw('jsonSchemaValidate', code, { timeout: 500 });
```

---

**最終更新**: 2026年2月
