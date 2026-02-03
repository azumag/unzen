# QJS フレームワーク統合ビジネスモデル：開発者体験を最優先した収益化

## エグゼクティブサマリー

QJSの成功は「JOBとして利用する」従来型モデルではなく、**フレームワークに組み込まれ開発者が意識せず使う**透過的インフラモデルに依存する。Next.js/VercelのISR/SSGを例に、利用者が「計算リソース」を意識しない自然な収益化を設計する。

---

## 1. 従来モデルの問題点

### 1.1 「JOB登録」モデルの障壁

```javascript
// ❌ 従来の煩雑なJOBモデル（使われない）
import { QJS } from '@unzen/sdk';

async function processData(data) {
  // 1. JOBを定義
  const job = await QJS.createJob({
    code: `
      function process(input) {
        return input.map(x => x * 2);
      }
    `,
    input: data,
    timeout: 50
  });
  
  // 2. 実行を待機
  const result = await job.waitForCompletion();
  
  // 3. 結果取得
  return result.output;
}
```

**問題**:
- 新しい概念（Job, Worker, Timeout）の学習コスト
- コードの分断（本体と分離された文字列）
- エラーハンドリングの複雑化
- デバッグ困難

### 1.2 開発者が求める体験

```javascript
// ✅ 理想的な透過的モデル（自然に使われる）
import { processData } from './utils';

// 何も意識しない。普通に書くだけ。
const result = await processData(data);
// → 内部で自動的にQJS Workerで実行される
```

**重要**: 開発者は「QJSを使っている」という意識すら不要。

---

## 2. Next.js統合モデル（戦略的パートナーシップ）

### 2.1 ISR（Incremental Static Regeneration）の代替

#### 現状の課題
```javascript
// pages/blog/[slug].js
export async function getStaticProps({ params }) {
  // 問題1: Vercelの無料枠をすぐ使い切る
  // 問題2: 大規模サイトでISRが高額請求に
  const post = await fetch(`https://api.example.com/posts/${params.slug}`);
  return {
    props: { post },
    revalidate: 60, // 60秒ごとに再レンダリング
  };
}
```

**Vercelのコスト構造**:
- Serverless Function実行: $40/百万回（Proプラン）
- ISR再レンダリング: 関数実行 + Edgeキャッシュ更新
- 大規模ブログ（1000記事×1日3回更新）= 月9万回実行 = $360/月

#### QJS統合モデル

```javascript
// next.config.js（フレームワークレベルで統合）
module.exports = {
  experimental: {
    // ✅ 開発者は1行追加だけ
    distributedISR: true, // QJS WorkerでISR実行
  },
};

// pages/blog/[slug].js（通常通り）
export async function getStaticProps({ params }) {
  // 内部で自動的にQJS Workerに分散実行
  const post = await fetch(`https://api.example.com/posts/${params.slug}`);
  return {
    props: { post },
    revalidate: 60,
  };
}
```

**開発者体験**:
1. `next.config.js`に1行追加
2. コードは一切変更不要
3. ISRが自動的に分散実行される
4. 請求はVercel経由で統合

### 2.2 画像最適化（sharp代替）

#### 現状の課題
```javascript
// Next.js Imageコンポーネント
import Image from 'next/image';

<Image 
  src="/photo.jpg"
  width={800}
  height={600}
  // → 内部でsharp（libvips）が動作
  // → Vercelで高額なリソース使用
/>
```

**問題**:
- sharpはメモリを多量に消費（128MB以上）
- Vercelの無料枠をすぐ超過
- 画像多いサイトで月$100以上

#### QJS統合モデル

```javascript
// next.config.js
module.exports = {
  images: {
    // ✅ 1行追加で自動最適化
    optimizer: 'unzen', // QJS Workerで画像処理
    formats: ['image/webp'],
  },
};

// 通常通りImageコンポーネントを使用
import Image from 'next/image';
<Image src="/photo.jpg" width={800} height={600} />
// → 自動的にQJS WorkerでWebP変換・リサイズ
```

**処理内容（純粋計算）**:
- Base64デコード → ピクセル配列
- リサイズ計算（バイリニア補間等）
- WebPエンコード（Wasm実装）
- **外部接続なし** ✅

### 2.3 ビルド時SSGの高速化

#### 現状の課題
```bash
# 大規模サイト（10000ページ）のビルド
$ next build

# → ローカルでは数十分かかる
# → Vercelでも並列度に限界あり
# → 高額なビルド時間課金
```

#### QJS分散ビルドモデル

```javascript
// next.config.js
module.exports = {
  experimental: {
    // ✅ ビルドを分散化
    distributedBuild: {
      enabled: true,
      parallelism: 100, // 100並列でページ生成
    },
  },
};
```

**ビルドプロセス**:
1. Next.jsがビルドを開始
2. ページ生成タスクをQJSネットワークに分散
3. 各Workerが`getStaticProps`を実行
4. 結果を収集して静的HTML生成
5. **ビルド時間を1/10に短縮**

---

## 3. 収益化モデル：開発者が意識しない課金

### 3.1 インフラ抽象化モデル（推奨）

```
開発者
  ↓ 通常通りVercelを使用
Vercel
  ↓ 内部でQJSを利用（開発者は意識しない）
QJS Platform
  ↓ 分散計算リソース提供
Global Worker Network
```

**請求フロー**:
1. 開発者はVercelに従量課金
2. VercelはQJSにAPI使用料を支払い
3. QJSはパートナー料金（30%割引）で提供

**料金例**:
| プラン | Vercel課金 | QJS内部コスト | QJS粗利 |
|-------|-----------|--------------|--------|
| Pro | $100/月 | $30/月 | $70/月 |
| Enterprise | $1,000/月 | $300/月 | $700/月 |

### 3.2 プラグイン課金モデル

#### WordPressモデル参考
```
無料版: 基本機能（月1万回実行まで）
  ↓
Pro版: $29/月（無制限実行 + 優先処理）
  ↓
Enterprise: カスタム価格
```

#### Next.jsプラグイン実装
```javascript
// next.config.js（無料版）
const { withUnzen } = require('@unzen/next');
module.exports = withUnzen({
  unzen: {
    tier: 'free', // 月1万回実行まで
  },
});

// 制限超過時 → 自動的にVercel標準機能にフォールバック
```

**アップグレード契機**:
- 制限超過時の警告（ビルドログに表示）
- 処理時間の遅延（Worker枯渇）→ Pro版で優先処理
- ダッシュボードで使用量可視化

### 3.3 非対称課金モデル（革新的）

```javascript
// ユーザー体験の変化なし
// 裏側で自動的に最適リソース選択

async function getData() {
  const data = await fetch('/api/data');
  return data;
}

// 裏側の動作:
// 1. 軽量処理（<50ms）→ QJS Worker（無料/低コスト）
// 2. 重い処理（>50ms）→ Lambda/Cloud Functions（標準料金）
// 3. 自動的に最適なリソースを選択
```

**開発者メリット**:
- 意識せずコスト最適化
- 自動フォールバックで信頼性確保
- 請求は統合された形で可視化

---

## 4. フレームワークパートナーシップ戦略

### 4.1 パートナー候補（優先度順）

#### Priority 1: Vercel / Next.js
**理由**:
- ISR/画像最適化のコスト問題が深刻
- エッジファーストの戦略と親和性
- 既存のインフラ統合実績（Cloudflare Workers等）

**提案内容**:
```
「Vercel Edge + unzen Distributed Workers」
- ISRの90%コスト削減
- 画像最適化のメモリ問題解決
- ビルド時間の短縮

パートナー条件:
- VercelはQJS APIを利用
- 収益シェア: QJS 30%, Vercel 70%
- 共同マーケティング
```

#### Priority 2: Netlify
**理由**:
- ビルド時間の制限が課題
- コスト競争力が必要

**提案内容**:
```
分散ビルドシステムの統合
- 大規模サイトのビルドを高速化
- ビルド時間制限の緩和
```

#### Priority 3: WordPressエコシステム
**理由**:
- 世界40%のWebサイト
- ホスティングコストが課題

**提案内容**:
```
WordPressプラグイン
- レンダリングの分散化
- キャッシュ再生成の高速化
```

### 4.2 パートナー価格モデル

```javascript
// QJSパートナーAPI料金体系
const partnerPricing = {
  // Vercel等大規模パートナー向け
  tier1: {
    name: 'Enterprise Partner',
    minCommitment: '$50,000/月',
    rate: '$0.000001/実行', // 標準の半額
    support: '24/7専任',
    features: ['専用Workerプール', 'カスタムSLA'],
  },
  
  // 中規模フレームワーク向け
  tier2: {
    name: 'Growth Partner',
    minCommitment: '$5,000/月',
    rate: '$0.000005/実行', // 標準の25%割引
    support: 'ビジネス時間',
    features: ['優先サポート', '共同マーケティング'],
  },
  
  // 個人開発者向け
  tier3: {
    name: 'Community Partner',
    minCommitment: '$0',
    rate: '$0.00002/実行', // 標準料金
    support: 'コミュニティ',
    features: ['基本APIアクセス'],
  },
};
```

---

## 5. 開発者オンボーディング：摩擦ゼロ設計

### 5.1 ステップ1: ワンラインプラグイン

```bash
# インストール
npm install @unzen/next

# next.config.js（3行追加）
const { withUnzen } = require('@unzen/next');
module.exports = withUnzen({ /* 既存設定 */ });
```

**完了**。後は通常通り開発。

### 5.2 ステップ2: 自動最適化

```javascript
// 開発者は何も変更しない
export async function getStaticProps() {
  // このコードが自動的に最適化される
  const data = await fetch('https://api.example.com/data');
  return { props: { data } };
}

// @unzen/nextがビルド時に:
// 1. 純粋計算部分を抽出
// 2. QJS Workerで分散実行
// 3. 結果をキャッシュ
```

### 5.3 ステップ3: 透明な請求

```
Vercel請求書:
━━━━━━━━━━━━━━━━━━━━━
Serverless Functions  $80.00
Edge Middleware        $12.00
✨ Distributed ISR     $8.00  ← QJS（Vercel標準比90%削減）
✨ Image Optimization  $4.00  ← QJS
━━━━━━━━━━━━━━━━━━━━━
合計                  $104.00

（旧モデルでは$200+の予定）
```

**開発者認識**: "Vercelが安くなった"（QJSの存在を意識しない）

---

## 6. 技術的実装：フレームワーク統合アーキテクチャ

### 6.1 コンパイル時コード分析

```javascript
// @unzen/webpack-plugin
class UnzenWebpackPlugin {
  apply(compiler) {
    compiler.hooks.emit.tap('UnzenPlugin', (compilation) => {
      // getStaticProps/getServerSidePropsを検出
      const serverFunctions = this.extractServerFunctions(compilation);
      
      // 純粋計算部分を抽出
      const pureComputations = serverFunctions.map(fn => ({
        id: fn.name,
        code: this.extractPureCode(fn),
        dependencies: this.analyzeDependencies(fn),
      }));
      
      // 外部接続を検出した場合は警告
      pureComputations.forEach(comp => {
        if (comp.hasExternalCalls) {
          console.warn(`⚠️ ${comp.id} contains external calls. Skipping optimization.`);
        }
      });
      
      // QJS Worker向けコードを生成
      this.generateWorkerBundle(pureComputations);
    });
  }
}
```

### 6.2 ランタイムフォールバック

```javascript
// @unzen/nextランタイム
export async function executeWithFallback(code, input) {
  try {
    // 1. QJS Workerで試行
    const result = await qjsClient.execute({
      code,
      input,
      timeout: 50,
      maxRetries: 2,
    });
    
    return result;
  } catch (error) {
    // 2. 失敗時は標準Serverless Functionにフォールバック
    console.log('QJS unavailable, falling back to standard execution');
    return await standardServerlessExecution(code, input);
  }
}
```

### 6.3 エッジと分散の協調

```
リクエストフロー:

1. エッジ（Vercel Edge）
   ↓ キャッシュチェック
2. キャッシュミス
   ↓ 
3. 判定: 純粋計算か？
   ├─ Yes → QJS Worker（コスト最適）
   └─ No  → Serverless Function（標準）
   ↓
4. 結果をエッジキャッシュ
   ↓
5. レスポンス
```

---

## 7. 成功指標と評価

### 7.1 採用率指標

| フェーズ | 指標 | 目標値 |
|---------|------|--------|
| **MVP** | パートナー統合 | 1フレームワーク（Next.js） |
| **成長** | サイト数 | 1,000サイト |
| **拡大** | 月間実行数 | 10億回 |
| **成熟** | パートナー数 | 5+フレームワーク |

### 7.2 開発者満足度指標

```
アンケート項目:
• "QJSの存在を意識した回数" → 目標: 0回
• "コスト削減を実感したか" → 目標: 90%がYes
• "設定の複雑さ" → 目標: 1行以下
• "エラーの発生頻度" → 目標: 標準機能と同等
```

### 7.3 ビジネス指標

```
収益モデル:
• パートナーAPI利用料: 70%
• 直接利用（フリーミアム）: 20%
• エンタープライズライセンス: 10%

目標MRR（月間経常収益）:
Year 1: $10,000
Year 2: $100,000
Year 3: $500,000
```

---

## 8. まとめ：摩擦ゼロへの道

### 成功の鍵

1. **「インフラとして消える」**
   - 開発者はQJSの存在を意識しない
   - Vercel/Netlifyが「安くなった」と感じる

2. **「最適化は自動的に」**
   - ビルド時に純粋計算を自動検出
   - フォールバックは透過的

3. **「請求は統合されて」**
   - 別途QJS請求書は届かない
   - 既存インフラ請求に含まれる

### ビジョンの再定義

> 修正前: "unzenは分散コンピューティングプラットフォーム"
> 
> **修正後: "unzenはフレームワークの裏側で動く、透明な計算最適化レイヤー"**

開発者は永遠に「JOB」を書かない。
普通にフレームワークを使うだけで、
自動的に分散化とコスト最適化が行われる。

それがunzenの真の価値。

---

**ドキュメントバージョン**: 1.0  
**作成日**: 2026年2月  
**ステータス**: 戦略提案（要Vercel等パートナー協議）
