# 広告オプトアウトを選べる Unzen ページ設計

広告表示や広告計測に参加したくない訪問者でも、Unzen を使うページの主要機能を
利用できるようにするための設計を定義する。目的は、広告からの収益化と、
訪問者ブラウザでの計算参加を同一視しないことにある。

## 前提

Fetch 専用サーバコンテナ + Unzen サイト構成では、サーバコンテナは upstream fetch、
cache、secret 境界、Unzen manifest/code/worker 配信だけを担当し、表示用 view model
生成は訪問者ブラウザの Unzen function に委譲する。

この構成で広告を載せる場合でも、次の選択は分けて扱う。

- 広告表示や広告ネットワークへのリクエストを許可するか
- Unzen function をブラウザ sandbox で実行するか
- 代替の支払い、ログイン、低機能表示などで広告なし利用を許可するか
- crawler snapshot や link preview に広告状態を混ぜるか

広告を拒否した訪問者に、広告 SDK のロードや計測 endpoint への送信を行ってはいけない。
一方で、Unzen function は広告ではなくページ機能の内部計算なので、広告同意とは別の
UI 文言と状態で扱う。

## 基本方針

| 選択状態 | 広告 SDK / 計測 | Unzen browser 実行 | サーバ fallback | 表示 |
|---|---|---|---|---|
| Ads accepted | 許可された広告のみロード | 通常通り実行 | 明示許可時のみ | 通常 UI |
| Ads opted out | ロードしない | 通常通り実行可 | 広告拒否を理由に使わない | 広告なし UI |
| Compute disabled | ロード可否は広告設定に従う | 実行しない | 機能ごとに明示許可 | snapshot / 低機能 UI |
| Privacy required | ロードしない | private 入力を使う計算は避ける | 使わない | noindex / 最小 UI |

広告オプトアウトは「広告リクエストを送らない」ことを保証する状態であり、
Unzen の計算参加を止める状態ではない。計算参加を止めたい訪問者には、
別の `computeParticipation` 設定を用意する。

## 状態モデル

広告と計算参加を同じ boolean にしない。ページ shell は、少なくとも次の状態を持つ。

```typescript
type ParticipationState = {
  adsConsent: 'accepted' | 'opted-out' | 'unknown';
  computeParticipation: 'enabled' | 'disabled';
  monetizationMode: 'ads' | 'subscription' | 'sponsor' | 'none';
  snapshotMode: 'indexable' | 'noindex';
};
```

`adsConsent: 'unknown'` の間は広告 SDK をロードしない。広告なしでも主要表示に必要な
raw source fetch と Unzen manifest/code/worker 配信は継続できる。

## Next.js App Router の構成

```text
app/
  components/
    AdBoundary.tsx          # adsConsent accepted のときだけ広告 SDK をロード
    ParticipationGate.tsx   # computeParticipation と fallback UI を選択
    FetchOnlyPage.tsx       # Unzen function 呼び出し
  api/
    source/
      route.ts              # 広告状態に依存しない raw fetch
    consent/
      route.ts              # consent cookie の更新
lib/
  participation.ts          # cookie / user setting から状態を読む
```

`AdBoundary` は広告 SDK の dynamic import、script tag、広告 iframe を
`adsConsent === 'accepted'` の後に限定する。

```tsx
'use client';

import { useEffect } from 'react';

export function AdBoundary({ adsConsent }: { adsConsent: 'accepted' | 'opted-out' | 'unknown' }) {
  useEffect(() => {
    if (adsConsent !== 'accepted') return;
    void import('@/lib/load-ads').then((mod) => mod.loadAds());
  }, [adsConsent]);

  if (adsConsent !== 'accepted') return null;
  return <aside id="ad-slot" aria-hidden="true" />;
}
```

`ParticipationGate` は広告拒否時にも Unzen 実行を止めない。止めるのは
`computeParticipation === 'disabled'` のときだけにする。

```tsx
'use client';

export function ParticipationGate({
  state,
  children,
  snapshot,
}: {
  state: ParticipationState;
  children: React.ReactNode;
  snapshot: React.ReactNode;
}) {
  if (state.computeParticipation === 'disabled') {
    return <>{snapshot}</>;
  }

  return <>{children}</>;
}
```

## UI と同意の境界

広告オプトアウト UI は、広告に関する選択だけを説明する。

- 「広告を表示しない」を選んだら、広告 SDK、広告計測、広告 iframe をロードしない
- 主要コンテンツが広告収益に依存する場合は、subscription、sponsor、低機能表示などの代替を示す
- Unzen browser 実行を止める設定は「端末内の計算を使わない」のように別名で出す
- 広告拒否を理由に、クローラー向け canonical snapshot へ広告状態を混ぜない

広告設定は cookie またはログインユーザー設定に保存できる。ただし、保存前の
初回表示では広告をロードしない fail-closed 挙動にする。

## Crawler / snapshot との関係

Crawler snapshot は広告同意状態を持たない public projection として生成する。
広告あり/なしで canonical title、description、JSON-LD、body excerpt が変わってはいけない。

広告なし表示を選んだ訪問者も、hydration 前には同じ canonical snapshot を受け取り、
hydration 後に広告枠だけが省略される。

private data、reward state、広告視聴状態に依存するページは indexable snapshot にしない。
その場合は `noindex` を返し、広告 opt-out とは別の理由として扱う。

## サーバ境界

広告オプトアウト対応のために、server container へ表示用の集計、検索、並び替え、
Markdown 変換を戻してはいけない。server container が担当できるのは次に限る。

- consent cookie / user setting の読み書き
- 広告 SDK を読み込むかどうかの shell state 生成
- raw source fetch、cache、secret 境界
- Unzen manifest/code/worker 配信
- compute disabled 時の snapshot または低機能表示の返却

広告なし利用のために支払い確認やログイン確認が必要な場合も、認可判断は server container、
表示用 view model 生成は Unzen function という境界を維持する。

## 受け入れ条件

1. 広告 opt-out 時に広告 SDK、広告計測、広告 iframe がロードされない
2. 広告 opt-out と Unzen compute participation が別の状態として保存される
3. 広告拒否時も、許可された raw source fetch と Unzen browser 実行は継続できる
4. compute disabled 時は snapshot または低機能 UI を返し、暗黙の server fallback を使わない
5. crawler snapshot / JSON-LD / canonical metadata は広告同意状態に依存しない
6. server container は広告同意処理を追加しても request-time の表示用集計、検索、並び替え、Markdown 変換を行わない
