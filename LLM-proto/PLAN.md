# unzen-LLM 計画書 v3.15

## 本文書の位置づけ

既存のLLM関連文書(LLM-proto/README.md, cost-calculation系)は探索的な思考メモであり、文書間で矛盾が多数存在する。本文書はそれらを棄却し、複数回のレビューを経て確定した方針を記載する。

---

## 1. 基本方針

### 1.1 確定事項

| 項目 | 決定 | 理由 |
|------|------|------|
| Worker報酬 | **必要** | 報酬なしでは誰もWorkerを設置しない。ノード数が確保できない |
| 第三者接続 | **禁止** | ユーザーブラウザから任意の第三者サーバーへの通信は危険すぎる |
| LLMの目的 | **広告に依存しない追加収益手段** | 胴元の収益ではなく、Web全体の広告依存度を低減する(想定効果: サイト収益の+5-15%、4.2項参照)。広告の全面置換ではなく、第三の選択肢を提供する |

### 1.2 通信ポリシーの定義

第三者通信禁止の適用範囲と、安全境界の実装方針:

```
禁止(第三者通信):
  - 任意URLへの fetch / XMLHttpRequest
  - 任意ピアへの WebRTC接続
  - DNS解決を利用した情報漏洩
  - navigator.sendBeacon 等のビーコン送信

許可(unzenインフラとの制御通信):
  - Coordinatorとの WebSocket接続(タスク受信・結果送信・heartbeat)
  - CDNからのモデル重みダウンロード(unzen管理エンドポイント)
  - チェックポイントデータの送受信(Coordinator経由)

原則:
  Workerは「unzenが管理するエンドポイント以外と通信できない」
```

**攻撃者モデル(誰が何をできる前提か)**:

```
想定する攻撃者と脅威:

1. 悪意あるサイト運営者:
   unzen SDKを改竄し、推論Worker経由で訪問者のブラウザから
   任意サーバーへデータを送信しようとする
   → 防御: CSP/サンドボックスにより、SDK改竄しても通信先を変更不可

2. 悪意あるユーザー(Worker側):
   推論結果を横取りしたり、中間状態から入力を復元しようとする
   → 防御: 各Workerは部分レイヤーのみ保持。Coordinator経由の暗号化転送

3. 中間者攻撃:
   Coordinator-Worker間の通信を傍受・改竄する
   → 防御: TLS(WSS)による暗号化。コード署名による改竄検知

4. Coordinator偽装(MITM):
   DNSスプーフィングやネットワーク経路改竄により偽Coordinatorから不正コードを配布
   → 防御: TLS(証明書検証) + コードのハッシュ署名検証(unzen公開鍵)

想定しない攻撃者(スコープ外):
  - ブラウザ自体の脆弱性を突く攻撃(ブラウザベンダーの責任)
  - OS/カーネルレベルの攻撃
  - ユーザー自身が意図的にDevToolsで通信制限を迂回(自己責任)
  - 正規Coordinatorサーバーの侵害(インフラセキュリティの問題。
    対策はデプロイパイプラインの監査・署名鍵のHSM管理等、
    運用セキュリティとして別途策定する)
```

**安全境界の実装(SDKハードコードだけでは不十分)**:

「接続先をSDKにハードコード」するだけでは、ブラウザ上で実行される任意JSがWebSocketの宛先を書き換えたり、独自通信を開始するリスクを防げない。以下の多層防御が必要:

```
適用スコープ:
  top-level page → サイト運営者のページ。unzenは関与しない
  └─ sandbox iframe (unzen SDK) → unzenが提供するiframe。ここに全防御を適用
       └─ Dedicated Web Worker → 推論処理の実行単位。iframe内から生成

  CSPとCOOP/COEPはiframeのレスポンスヘッダーで設定(unzen CDNが配信)。
  サイト運営者のtop-levelページのCSPには依存しない。

防御層:

1. CSP(Content Security Policy) — 適用: sandbox iframe のレスポンスヘッダー
   connect-src <coordinator> <cdn>;  ← 具体ドメインは環境(prod/staging/dev)で差し替え
   script-src 'self';  ← 暫定方針
   (例: prod環境では connect-src https://*.unzen.dev wss://*.unzen.dev)
   → iframe内の全コード(Web Worker含む)に適用される
   → サイト運営者のtop-level CSPとは独立
   注: Web Worker生成(blob: URL)やWasm実行にはscript-src 'self'だけでは
   不足する可能性がある(ブラウザ実装により異なる)。
   PoCで実際に不足するか判定し、不要なら追加しない。
   必要な場合のみ worker-src blob: や 'wasm-unsafe-eval' を最小限で追加する

2. サンドボックスiframe — 適用: top-level → iframe の境界
   <iframe sandbox="allow-scripts" src="https://worker.unzen.dev/runner">
   allow-same-origin は不許可
   → iframe内コードはtop-levelのDOM/Cookie/Storageにアクセス不可
   → サイト運営者の改竄JSからiframe内部を操作不可(cross-origin制約)

3. Web Worker隔離 — 適用: iframe内のDedicated Worker
   推論処理はiframe内から生成されたDedicated Web Worker内で実行
   WorkerはiframeのCSPを継承するため、connect-srcの制限が有効
   importScripts / dynamic import はCSPのscript-srcで制限

4. COOP/COEP ヘッダー — 適用: sandbox iframe のレスポンスヘッダー
   Cross-Origin-Opener-Policy: same-origin
   Cross-Origin-Embedder-Policy: require-corp
   → iframe内からのクロスオリジンリソース読み込みを遮断

5. 推論コードの署名検証 — 適用: iframe初期化時
   Coordinatorから配布される推論コードにハッシュ署名
   iframe内のローダーが検証後にのみ実行
   → 改竄コードの実行を防止
```

これらの組み合わせにより、「第三者通信禁止」をブラウザのセキュリティ機構レベルで強制する。防御の起点はunzen CDNが配信するiframeのレスポンスヘッダー(CSP/COOP/COEP)であり、サイト運営者のページ側の設定には依存しない。SDKのハードコードは最外層の実装であり、安全保証はCSP/サンドボックス/COOP-COEPの多層構造に依存する。

### 1.3 QJSとの関係

- **QJS**: 技術的意義のあるOSSプロジェクトである。収益化は不要である。独立して進める
- **LLM**: サービスとして展開する。広告に依存しないWebの収益化インフラである
- 両者は独立したプロジェクトである。コードベースの共有・依存はしない
- 設計パターンは相互に参考にし得るが、一方の成否が他方に影響しない前提で進める

---

## 2. ビジョン: 広告のカウンターパート

### 2.1 問題認識

```
現在のWebの収益構造:
  広告モデル → ユーザーの注意力を売る → 追跡・行動操作 → 体験劣化

  広告ブロッカー台頭(利用率推定40-45%、出典により幅あり)
    → パブリッシャーの収益が相当割合消滅
    → ペイウォール化
    → 情報アクセスの有料化
    → オープンWebの縮小

ミッシングパーツ:
  広告でもペイウォールでもない、第三の収益化手段が存在しない
```

### 2.2 unzen-LLMの提案

```
ユーザーが「注意力」ではなく「余剰GPU時間」で対価を払う

  売るもの: ユーザーの注意力 → ユーザーのデバイスの余剰計算リソース
  買う人:   広告主 → LLM推論を必要とするAPI顧客

収益フロー:
  API顧客(推論需要) → unzenプラットフォーム → ブラウザWorker → サイト運営者に報酬
```

### 2.3 正確なポジショニング

unzen-LLMは**広告の全面置換を目指さない**。広告と並立する第三の収益手段である。

```
目指すもの:
  - 広告ブロッカーで失われた収益(全体の40-45%)を部分回収する手段
  - ユーザーに「広告/計算参加/課金」の選択肢を与える仕組み
  - 世界的な広告忌避の潮流に対する、サイト運営者の新たな選択肢

目指さないもの:
  - 広告の完全代替(RPMで広告に勝つことは当面の目標ではない)
  - unzenプラットフォーム自体の大規模収益化
```

### 2.4 広告との比較

| | 広告 | unzen-LLM |
|---|------|-----------|
| ユーザー体験 | 劣化(邪魔、追跡) | **影響最小(仮説)(※2)** |
| PVへの影響 | 下がる(広告忌避) | **低下しない(仮説)(※2)** |
| ブランドイメージ | 毀損リスクあり | **先進的イメージ** |
| ブロッカー耐性 | ブロックされると収益ゼロ | オプトインモデルのためブロック動機は相対的に低い(※1) |
| プライバシー | 追跡が前提 | **個人データ不要** |

※1: 技術的にはブラウザ拡張等でブロック可能。「止められない」わけではない。ブロック耐性の実際の強度は検証項目(7.4項)。
※2: バックグラウンド推論が端末の発熱・電池消耗・動作遅延を引き起こす場合、体験劣化やPV低下の可能性がある。「影響最小」「PV低下なし」は仮説であり、パイロット運用で検証する(7.4項)。

### 2.5 Coinhiveとの決定的な違い

| | Coinhive | unzen-LLM |
|---|---------|-----------|
| 計算の用途 | 暗号通貨マイニング(ゼロサム) | **LLM推論(実需のある有用な計算)** |
| 受益者 | マイナー/投機家 | **推論を使う企業・開発者** |
| 透明性 | 隠れて動作するケースが横行 | **明示的オプトイン必須** |
| ユーザー価値 | なし | **広告削除、機能アンロック** |
| 社会的意義 | なし | **広告依存からの脱却** |

---

## 3. UX設計
### 3.1 ユーザーへの提示方法

**パターンA: 広告除去の対価**
```
デフォルト: 広告が表示される
  ↓
「広告を消しますか? 代わりにバックグラウンドでAI計算に参加してください」
  ↓
オプトイン → 広告消える + バックグラウンドで推論処理
```

**パターンB: サブスクの代替**
```
有料機能(例: AI要約、高度な検索)
  ↓
「月額課金の代わりに、機能使用中にAI計算に参加すると無料で使えます」
  ↓
オプトイン → 機能無料解放 + 使用中に推論処理
```

### 3.2 ユーザーの選択肢

```
サイト訪問者に常に3つの選択肢:
  1. 広告を見る(従来通り)
  2. 計算に参加する(広告なし)
  3. 課金する(広告なし・計算なし)

→ ユーザーに主権を返す。既存の選択肢を奪わず、第三の選択肢を追加する
```

### 3.3 公平性への配慮

```
WebGPU非対応・低スペック端末のユーザー:
  計算参加は「第三の選択肢の追加」であり、非対応端末の既存体験は変わらない。
  ただし計算参加による恩恵(広告除去等)を受けられないため、
  相対的に不利な立場になる点は認識する。

対策:
  1. CPU推論による軽量参加:
     WebGPU非対応でもCPU推論(低速)で参加可能にする
     強制しない(ユーザーが選ぶ)
     制約: CPU推論はGPU比で10-100倍遅く、1推論あたりの収益貢献が極めて低い。
     そのため大規模モデルの推論ではなく、小型モデル(分類・エンベディング等)の
     限定タスクのみを割り当てる。広告除去等の恩恵は提供するが、
     プラットフォーム側にとっては収益性が低い参加形態であることを前提とする。

  2. 軽量タスクの提供:
     LLM推論以外の軽量計算タスク(分類、エンベディング等)を
     低スペック端末に割り当てることで参加機会を広げる

  3. 段階的な貢献度設定:
     端末性能に応じたCPU/GPU使用率上限をユーザーが設定可能
     低い設定でも長時間参加すれば恩恵を受けられる
```

---

## 4. 経済性分析

### 4.1 RPM(1000PVあたり収益)の試算

**注意: 以下の試算は全て仮定値に基づく。特にAPI販売単価は仮置きであり、実際の市場価格は需給・品質・レイテンシに依存する。経済性の確定には実測が必須(7.2項)。**

```
前提(全て仮置き・要実測):
  訪問者の平均滞在: 3分 = 180秒
  WebGPU対応端末率: 50-60%
  オプトイン率: 20-30%
  推論速度(30Bモデル部分推論): ~15 tokens/sec
  API販売単価: $0.001/1K output tokens ← 仮置き

楽観ケース(60% × 30%):
  有効訪問者率: 18%
  1訪問あたり生成量: 180秒 × 15 tokens = 2,700 tokens
  1訪問あたり収益: $0.0027
  RPM: $0.0027 × 1000 × 0.18 = $0.49

保守ケース(50% × 20%):
  有効訪問者率: 10%
  RPM: $0.0027 × 1000 × 0.10 = $0.27

比較:
  AdSense RPM: $1〜$3
  unzen-LLM RPM: $0.27〜$0.49

RPMの主な変動要因(独立変数の単純感度。各変数を単独で変化させた場合):
  API販売単価が$0.003なら → RPM $0.81〜$1.47(AdSense圏内に到達)
  推論速度が30 tokens/secなら → RPM $0.54〜$0.98
  オプトイン率が50%なら → RPM $0.68〜$1.23

注意: 上記は各変数が独立に改善する前提。現実には変数間に相関がある:
  - API単価↑ → 品質要求↑ → 推論速度制約あり
  - API単価↑ → 代替サービスとの価格差縮小 → 需要量↓
  - 推論負荷↑ → 端末への影響↑ → オプトイン率↓
  複数変数の同時改善は各変数の単純積より実現困難
```

### 4.2 広告との併用モデル

```
広告の全面置換ではなく、収益の補完として位置づける:

現状(unzenなし):
  全訪問者 100%
    ├─ 広告表示: 55-60% → AdSense RPM $1-3
    └─ 広告ブロッカー: 40-45% → 収益 $0
  実効RPM: $0.55〜$1.80

unzen-LLM導入後:
  全訪問者 100%
    ├─ 広告選択: 50% → AdSense RPM $1-3
    ├─ 計算参加: 30% → unzen RPM $0.27-0.49
    └─ どちらも拒否: 20% → 収益 $0
  実効RPM: $0.58〜$1.95

変化:
  広告ブロッカー使用者の30%から新規収益を獲得
  サイト全体で +5-15% の収益増(仮置き前提での推計)
```

### 4.3 置換可能条件

unzen-LLMが単独で広告を置換できる条件。これは長期的な可能性であり、確約ではない:

```
必要RPM: $1.00以上
必要条件(全てが同時に成立する必要がある):
  - API販売単価: $0.003/1K tokens以上(高付加価値モデル)
  - WebGPU対応率: 70%以上(端末の進化に伴い改善)
  - オプトイン率: 40%以上(UX改善とブランド確立)
  - 推論速度: 30 tokens/sec以上(ハードウェアの進化)

リスク:
  - 上記条件は複数の外部要因(端末進化、市場価格、ユーザー行動)に依存
  - いずれか1つでも未達成なら置換不可能
  - 達成時期は予測困難。端末進化とエコシステム成熟に完全依存

現時点の方針:
  広告との併用を前提とし、置換は「条件が揃えば可能」という位置づけ
  特定の達成時期は断定しない
```

### 4.4 API需要側

LLM推論のAPI需要は十分に存在する:
- 無料APIと課金APIの間に大きな性能差がある
- 極めて安価に使えるなら需要がある層は厚い
- バッチ処理・非リアルタイム用途なら高レイテンシを許容できる

### 4.5 長時間ワーカー戦略

4.1〜4.4項の試算は「通常のWebサイト訪問（平均3分）」を前提としているが、長時間起動するアプリケーションにWorkerを組み込むことで、セッション時間と安定性の両面で桁違いの改善が見込める。

#### 4.5.1 長時間ワーカーの類型

```
類型1: OBSブラウザソース
  配信者がOBSに設置するWebアプリケーション（オーバーレイ、チャットウィジェット等）。
  配信中は数時間〜半日にわたり起動し続ける。
  配信用PCは高スペック（GPU搭載率が高い）。
  想定セッション時間: 2〜8時間

類型2: ブラウザ拡張機能
  拡張機能のバックグラウンドコンテキスト内でWorkerを動作させる。
  ユーザーがブラウジングしている間、継続的に推論処理が可能。
  想定セッション時間: 1〜4時間/日

類型3: Electron/デスクトップアプリ組み込み
  Electronやその他のデスクトップアプリケーションにSDKを組み込む。
  アプリ使用中に余剰計算リソースを提供してもらう。
  ネイティブGPU API（CUDA/Metal）の利用も将来的に可能。
  想定セッション時間: 1〜数時間

類型4: デジタルサイネージ・キオスク端末
  24時間稼働する端末。管理者がオプトインすれば極めて安定した長時間ワーカーになる。
  想定セッション時間: 24時間（常時）
```

#### 4.5.2 経済性試算

**注意: 4.1項と同様、全て仮定値に基づく。**

```
前提:
  API販売単価: $0.001/1K output tokens（4.1項と同じ仮置き）
  推論速度: 15 tokens/sec（基準値。類型により異なる）

類型別の試算:

  OBSブラウザソース（4時間/セッション = 14,400秒）:
    GPU共有のためスロットリング: 10 tokens/sec（エンコードとGPU共有）
    生成量: 144,000 tokens/セッション
    収益: $0.144/セッション
    月間（20日配信）: $2.88/配信者

  ブラウザ拡張（3時間/日 = 10,800秒。1日の累計ブラウジング時間）:
    ブラウジング優先のためスロットリング: 8 tokens/sec
    生成量: 86,400 tokens/日
    収益: $0.086/日
    月間（30日）: $2.59/ユーザー

  Electronアプリ（1時間/セッション = 3,600秒）:
    アプリ処理優先: 12 tokens/sec
    生成量: 43,200 tokens/セッション
    収益: $0.043/セッション
    月間（20日使用）: $0.86/ユーザー

月間収益での比較（単位を統一）:
  通常Web訪問: $0.0027/セッション × 想定月間訪問数で変動
    （例: 月30セッション → $0.081/月）
  OBS: $2.88/月（通常Web月30セッション比 36x）
  拡張機能: $2.59/月（同 32x）
  Electron: $0.86/月（同 11x）

  注: 通常Webの「月間訪問数」はサイト・ユーザーにより大きく異なる。
  上記の月30セッション（≒毎日1回訪問）は比較のための仮置きであり、
  実際にはサイトの種類や訪問頻度に強く依存する。
  長時間ワーカーの優位性は「1セッションの長さ」に由来するため、
  訪問頻度が高いサイトとの差は縮まる。
```

#### 4.5.3 信頼性への影響

長時間ワーカーは離脱率が極めて低いため、信頼性計算の前提が根本的に変わる。

```
離脱率の比較（4秒セグメント中の離脱確率）:
  通常Web訪問: 0.7%〜2.9%（5.4項の3シナリオ）
  OBS配信中: ≈0.01%（配信の中断は稀）
  ブラウザ拡張: ≈0.1%（ブラウザ終了時のみ）
  Electron: ≈0.05%（アプリ終了時のみ）

  ※全て仮定値。実測するまで確定値としない。

長時間ワーカーの追加メリット:
  1. 単一ノードで複数セグメントを連続処理可能
     → チェックポイント転送オーバーヘッドの大幅削減
  2. モデル重みのキャッシュ効率が高い
     → 一度ロードしたら数時間使い続ける（再ロード不要）
  3. Coordinatorの割り当て判断が容易
     → 安定ワーカーに優先的にタスクを配分できる

単一ノード連続処理のトレードオフ:
  メリット:
    - チェックポイント転送（数MB × セグメント間）が不要 → レイテンシ削減
    - Coordinator側の割り当て・監視が単純化
  デメリット:
    - セグメント並列処理ができない → 全体レイテンシは直列分だけ増加
      （8セグメント並列: ~4秒、単一ノード直列: ~32秒 + 推論間オーバーヘッド）
    - 単一点障害: ノードが処理途中で落ちた場合、複数セグメント分をやり直し
      → 長時間ワーカーは離脱率が低いため発生頻度は低いが、
        発生時のコストは分散処理より大きい
    - 1ノードに全セグメントの重みをロードするにはVRAM 17GB+が必要
      → 大多数の端末では非現実的。2-4セグメント程度が現実的上限

  Coordinatorの判断基準（仮説）:
    - レイテンシ要求が厳しい → セグメント並列（複数ノード分散）
    - スループット重視/バッチ処理 → 安定ノードでの連続処理
    - この判断ロジックの最適化は実運用データに基づいて調整
```

#### 4.5.4 ハイブリッドワーカー戦略

短時間Web訪問者と長時間ワーカーを組み合わせることで、全体の安定性を高める。

```
ワーカープールの階層化:

  Tier 1: 常時稼働ワーカー（サイネージ等、24時間）
    → 最優先。複数セグメント連続処理。バックボーン

  Tier 2: 長時間ワーカー（OBS、拡張、Electron、1〜8時間）
    → 高優先。安定したタスク割り当て

  Tier 3: 通常Web訪問者（3〜10分）
    → バースト対応。需要増加時の弾力的リソース

Coordinatorの割り当て戦略:
  - 安定性の高いワーカーに複数セグメントをまとめて割り当て
  - Tier 1/2が十分なら、Tier 3への割り当てを減らし端末負荷を低減
  - Tier 3は「参加している」という体験を提供しつつ、
    全体の信頼性はTier 1/2が担保する
```

#### 4.5.5 技術的考慮事項

```
OBSブラウザソース:
  - GPU競合: OBSのエンコード（NVENC/AMF）と推論のGPU共有
    → エンコードはGPU専用エンジン（NVENC等）を使うため、CUDAコアとの直接競合は
      限定的な可能性があるが、VRAMやメモリバス帯域の競合は発生し得る（要検証）
    → 推論のGPU使用率に上限を設けるスロットリング機構が必要
  - メモリ: 配信PCは通常16GB+のRAM、VRAM 8GB+
    → 2.1GB/セグメントは問題なし。フルモデル(17GB)は一部のハイエンドGPUのみ

ブラウザ拡張 (Manifest V3):
  - Service Workerのライフサイクル制約（リスク: 高）:
    Chrome MV3のService Workerはアイドル30秒でターミネートされる。
    さらにChrome側のポリシー変更やメモリ圧迫時に強制終了される可能性がある。
    これはブラウザベンダーの実装依存であり、unzen側で制御できない。

    延命策（いずれも確実ではない）:
    a) Coordinatorとの持続的WebSocket接続でアクティブ状態を維持
       → Chromeが「アクティブな接続」をどう扱うかは実装依存
       → 将来のChrome更新で挙動が変わるリスクがある
    b) chrome.alarms API（最小間隔30秒）で定期ウェイクアップ
       → 起動→推論→スリープのサイクルになり、連続処理にならない
       → セグメント途中での中断が発生し得る

    失敗時の挙動:
    - Service Workerが強制終了 → 処理中のセグメントは失敗扱い
    - Coordinatorがheartbeat途絶を検知 → 別ワーカーに再割り当て
    - チェックポイントからの再開なので推論全体は失敗しないが、
      頻発すれば実質的にTier 3（短時間Web）と変わらない

    実用成立の条件:
    - PoCで「4秒のセグメント処理を中断なく連続実行できるか」を検証
    - WebSocket維持でService Workerが実際に延命されるか（Chrome, Firefox, Safari各ブラウザ）
    - 上記が不成立の場合、ブラウザ拡張は「類型2: 長時間ワーカー」ではなく
      Tier 3相当（ウェイクアップ間隔での断続的処理）に格下げする

    代替アプローチ:
    - OffscreenDocument APIでバックグラウンドページ相当の環境を確保
      → ただしこれもChrome側のライフサイクル制限を受ける可能性がある
    - サイドパネル（Side Panel API）を利用し、ユーザーが開いている間だけ動作
      → 長時間ワーカーとしての位置づけは弱まるが、確実に動作する

  - WebGPUアクセス:
    Service Worker内からのWebGPU利用は現時点で不可能な可能性が高い
    → OffscreenDocument API経由でのWebGPUアクセスを検討
    → PoCで動作確認が必須（不可能なら拡張機能経由のGPU推論自体が成立しない）

Electron/デスクトップアプリ:
  - WebGPUに加え、将来的にはネイティブGPU API（CUDA/Metal）対応の可能性
    → 推論速度が大幅に向上（WebGPU比で2-5x、要実測）
    → ただしSDKの複雑化とメンテナンスコストのトレードオフ
  - 初期はWebGPU(Electron内蔵Chromium)で統一し、需要に応じてネイティブ対応を検討

共通課題:
  - バッテリー消費: ノートPCでは電力消費が問題になる
    → AC電源接続時のみ動作するオプション
  - ユーザーへの透明性: リソース使用量のリアルタイム表示が必須
  - 長時間動作時のメモリリーク対策: 定期的なWorkerの再起動機構
```

#### 4.5.6 ワーカー獲得チャネル

```
OBS:
  - OBSプラグインマーケットプレイス（StreamElements等のプラットフォーム連携）
  - 配信者への報酬（配信収益の補助として訴求）
  - 「あなたの視聴者がAIを動かしている」という付加価値の訴求

ブラウザ拡張:
  - 独自拡張の配布（Chrome Web Store）
  - 既存の人気拡張への組み込みSDK提供（拡張開発者への報酬シェア）
  - 広告ブロッカー拡張との統合の可能性（広告の代わりに計算参加）

Electronアプリ:
  - アプリ開発者向けSDK提供
  - アプリの収益化手段として訴求（アプリ内広告の代替）
  - npm/パッケージマネージャ経由の簡単な組み込み

いずれも3.2項のユーザー選択肢の原則を守る:
  明示的オプトイン必須。デフォルトOFF。リソース使用量の透明な開示。
```

---

## 5. 技術設計: チェックポイント・リジューム方式

### 5.1 旧設計(破綻)の問題

```
All-or-Nothing パイプライン:
  Browser A → B → C → ... → H (80ホップ)
  1つ落ちたら全部やり直し
  成功率: 0.95^80 = 2% → 破綻
```

### 5.2 新設計: チェックポイント・リジューム

```
セグメント分割 + 中間状態保存:
  Browser A [Seg.1] → checkpoint → Browser B [Seg.2] → checkpoint → ...

  ノードが死んだ場合:
    → Coordinatorが検知(heartbeat途絶)
    → 直前のcheckpointから別のノードに再割り当て
    → 数秒のロスで復旧
```

### 5.3 パラメータ設計

**ターゲットモデル: 30Bクラス(4-bit量子化, ~17GB) ※EXAMPLE**

> [!IMPORTANT]
> 下記の30B / 8 segment / ~2.1GB / ~4秒は計画のための**EXAMPLE（仮定値）**であり、実測値ではありません。
> 権威あるmodel geometry（layer範囲・artifact hash・VRAM estimate）は[`SegmentedModelManifest`](./docs/model-manifest.md)が唯一のsource of truthであり、
> `Coordinator`とfeasibility gateは検証済みmanifestを消費します（#102対応済み）。placeholder hashはvalidatorがrejectします。

| パラメータ | 値 | 根拠 | 確度 |
|-----------|-----|------|------|
| セグメント数 | 8 | 1ノードあたり~2.1GBでWebGPU現実的（EXAMPLE） | 仮定(要検証) |
| 1セグメント処理時間 | ~4秒 | 30Bの部分推論想定 | 仮定(要実測) |
| 全体推論時間 | ~35秒 | 推論30秒+チェックポイント転送 | 仮定(要実測) |
| 中間状態サイズ | 数MB | hidden states + KV cache部分 | 仮定(要実測) |

**全て仮定値。技術検証フェーズで実測し確定する。**

### 5.4 信頼性計算

元データ「5%/30秒」は仮定であり実測値ではない。3シナリオで提示する。

**前提の注意**: 30秒単位の離脱率を4秒単位に換算している。この換算は「離脱が時間に対して一様に分布する」という仮定に基づくが、実際のユーザー行動は一様分布ではない可能性が高い(ページロード直後に集中する等)。実測による補正が必須。

```
楽観シナリオ(離脱率 5%/30秒):
  4秒あたり離脱率: ~0.7%
  リトライ1回込み: 0.007 × 0.007 = 0.005%/セグメント
  8セグメント全体の成功率: 99.96%

保守ケース(離脱率 10%/30秒):
  4秒あたり離脱率: ~1.4%
  リトライ1回込み: 0.014 × 0.014 = 0.02%/セグメント
  8セグメント全体の成功率: 99.84%

悲観シナリオ(離脱率 20%/30秒):
  4秒あたり離脱率: ~2.9%
  リトライ1回込み: 0.029 × 0.029 = 0.084%/セグメント
  8セグメント全体の成功率: 99.33%

いずれのシナリオでも旧設計(2%)とは桁違いに改善。
ただし全ての数値は仮定に基づく。実測するまでは確定値としない。
```

### 5.5 アーキテクチャ

```
┌──────────────────────────────────────────────────┐
│  API顧客                                         │
│  推論リクエスト送信                                │
└──────────┬───────────────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────────────┐
│  Coordinator (Cloudflare Workers)                 │
│  - リクエスト受付                                  │
│  - セグメント割り当て                              │
│  - チェックポイント中継・保存                      │
│  - ノード死活監視(WebSocket heartbeat)            │
│  - 障害検知 + 別ノードへの再割り当て               │
│  - 結果集約・返却                                  │
└──────────┬───────────────────────────────────────┘
           │
     ┌─────┼─────┬─────┬─────┐
     ▼     ▼     ▼     ▼     ▼
   [Seg1] [Seg2] [Seg3] ... [Seg8]
   Browser Browser Browser   Browser
   (Site A (Site B (Site C   (Site X
    訪問者) 訪問者) 訪問者)   訪問者)
     │           │
     └──checkpoint──┘
      (数MB, Coordinator経由)

通信は全てunzen管理エンドポイントに限定(1.2項参照)
安全境界はCSP/サンドボックス/COOP-COEPで強制(1.2項参照)
```

### 5.6 技術課題

| 課題 | 難易度 | 対策方針 |
|------|--------|---------|
| WebGPUでの部分モデル推論 | 高 | WebLLM(MLC AI)の拡張。部分レイヤーロード実装 |
| チェックポイントの高速シリアライズ | 中 | hidden statesのバイナリ転送。数MBなので数百ms想定 |
| Coordinator設計 | 中 | Cloudflare Workers上に構築。QJSのDispatcher設計パターンを参考にする(コード依存はしない) |
| モデル重みの配信・キャッシュ | 低 | unzen管理CDN + IndexedDB。2回目以降は即座にロード |
| ノード死活監視 | 中 | Coordinator-Worker間WebSocket + タイムアウト検知 |
| 通信の安全境界実装 | 高 | CSP + サンドボックスiframe + COOP/COEP + コード署名検証(1.2項) |

---

## 6. 旧文書からの変更点

| 項目 | 旧文書の記述 | 本計画書 |
|------|------------|---------|
| 目的 | 安価なLLM API | **広告に依存しない追加収益手段** |
| Worker報酬 | 文書により不要/必要が混在 | **必要(確定)** |
| 通信制限 | 「外部接続禁止」(曖昧) | **第三者通信禁止 + unzenインフラ通信は許可 + 安全境界を多層防御で実装(1.2項)** |
| 分散方式 | 80ホップ All-or-Nothing | **8セグメント・チェックポイント方式** |
| ターゲットモデル | 70B | **30Bクラス(段階的に拡大)** |
| 70Bコスト | $0.0015 vs $0.0085(矛盾) | **未確定(30Bで先に検証)** |
| LLM価格 | $0.006 vs $0.0015(矛盾) | **未確定(需給で決定)** |
| QJSとの関係 | シナジー前提 | **独立。設計パターンの参考はOK、コード依存はしない** |
| フレームワーク統合 | ISR/fetch前提(矛盾) | **対象外(第三者通信禁止)** |
| RPMポジション | 広告の完全代替 | **広告との併用。ブロッカー離脱収益の回収** |
| 信頼性計算 | 単一シナリオ(根拠不明) | **3シナリオ提示(実測まで確定値としない)** |

---

## 7. 次のステップ

### 7.1 技術検証(最優先)

0. [2B / 2-worker prototype](./docs/2b-two-worker-prototype.md) で、2Bクラスモデルを2セグメント・2ワーカーに固定して、WebGPU実行、チェックポイント転送、IndexedDBキャッシュ、ワーカー喪失時のリジュームを先に実測する
1. [Adaptive chunk dispatcher](./docs/adaptive-chunk-dispatcher.md) で、ワーカーの演算能力・稼働時間・余剰負荷に基づいてチャンクサイズと連続チャンク割り当てを変える Coordinator 仕様を固める
2. [WebGPU 30B partial inference feasibility](./docs/webgpu-30b-partial-inference-feasibility.md) で、[`SegmentedModelManifest`](./docs/model-manifest.md)、checkpoint tensor shape、runtime候補、AdaptiveChunkDispatcher の telemetry 前提を metadata/report gate として検証し、実ブラウザ WebGPU 計測へ進む条件を固める
3. [Checkpoint transfer measurement](./docs/checkpoint-transfer-measurement.md) で、checkpoint(hidden states)のシリアライズ・転送サイズ・速度・retry failure を report gate として検証し、manual browser/WebGPU 計測へ進む条件を固める
4. [Browser worker retention measurement](./docs/browser-worker-retention-measurement.md) で、session duration distribution、retention curve、Tier 3 early abandon、checkpoint resume / retry impact を report gate として検証し、実際のサイトでのブラウザ離脱率測定へ進む条件を固める
5. [Coordinator prototype](./docs/coordinator-prototype.md) で、API受付、worker registration / heartbeat、AdaptiveChunkDispatcher assignment、Coordinator checkpoint relay、resume/retry report、Tier 3 churn eligibility を simulated report gate として束ねる
6. [Coordinator durability (#103)](./docs/coordinator-durability.md) で、durable request state、idempotency、request/attempt/lease identity、retry/cancellation、checkpoint envelope、worker generation policy を `DurableCoordinator` + `DurableObjectRepository` の contract testとして検証する。SQLite-backed Durable Objectのproduction storage adapterは実装済みで、実deployment evidenceは別途取得する
6. [Workers Coordinator prototype](./docs/workers-coordinator-prototype.md) で、Cloudflare Workers 境界の API lifecycle、Durable Object single-writer worker state、AdaptiveChunkDispatcher assignment import、Coordinator-owned checkpoint relay、worker loss retry/resume impact、WebSocket heartbeat p95 fan-out、direct worker-to-worker rejection を report gate として検証する
7. [Workers Coordinator Miniflare smoke](./docs/workers-coordinator-prototype.md) で、Miniflare/workerd の real Worker fetch、Durable Object storage、WebSocket upgrade、direct worker-to-worker rejection、load-shaped request concurrency、client-side heartbeat timing、restart persistence を focused smoke として検証する
8. [Workers Coordinator deployed smoke](./docs/workers-coordinator-prototype.md) で、authenticated Wrangler preview / deployed Worker URL の auth header presence、Durable Object migration tag、real browser WebSocket timing、edge placement variance、direct worker-to-worker rejection を focused smoke として検証する
9. [Workers Coordinator production observability canary gate](./docs/workers-coordinator-prototype.md) で、durable per-request metrics export、browser WebSocket p95 / edge placement variance / direct worker-to-worker rejection / upstream failure reason の alert threshold、canary release decision、rollback checkpoint boundary を deterministic report gate として検証する
10. [Workers Coordinator signed runner release gate](./docs/workers-coordinator-prototype.md) で、signed runner の CSP connect-src、sandbox iframe allow-scripts 境界、top-level DOM / Cookie / Storage 非依存、COOP / COEP header、Coordinator / CDN 以外への network attempt blocking を deterministic release gate として検証する
11. [Workers Coordinator signed runner browser preview gate](./docs/workers-coordinator-prototype.md) で、同じ signed runner safety boundary を browser evidence envelope と authenticated Wrangler preview / deployed Worker URL の header/network contract で検証し、`validateEvidenceEnvelope()` を通った場合のみ provenance を報告する
12. [Workers Coordinator signed runner WebGPU worker pilot gate](./docs/workers-coordinator-prototype.md) で、preview runner URL 上の model segment execution、IndexedDB cache、Coordinator-owned checkpoint relay、CSP/sandbox/COOP-COEP/network boundary の同時成立を evidence envelope で検証する。`real`という名称でも入力がenvelope未検証なら`contract-tested`に留まる
13. [WebGPU worker performance / fallback telemetry gate](./docs/workers-coordinator-prototype.md) で、segment latency distribution、cache hit/miss timing、checkpoint relay duration、WebGPU device loss、CPU fallback routing を evidence envelope で検証し、upstream pilotのreadinessを超えて昇格させない
14. [Production worker fleet SLO / cost gate](./docs/workers-coordinator-prototype.md) で、device tier 別 p95 latency、fallback rate、cache warmup cost、checkpoint relay spend、user opt-in impact、promote/hold thresholds を report 化する
15. [Publisher reward and abuse-resistant settlement gate](./docs/workers-coordinator-prototype.md) で、opt-in fleet contribution と Coordinator checkpoint relay evidence を publisher 報酬 accrual に変換し、spoofed worker / replayed checkpoint claim / cost-shifting abuse を検出する
16. [Publisher reward pilot ledger and payout reconciliation gate](./docs/workers-coordinator-prototype.md) で、settlement decision を監査可能 ledger に保存し、payout batch と reward accrual の差分・dispute evidence を検証する
17. [Publisher reward real-money payout pilot dry-run gate](./docs/workers-coordinator-prototype.md) で、実決済前の payout provider dry-run、tax / invoice metadata、operator approval evidence、publisher-facing reconciliation export、live money movement へ進む promote/hold thresholds を検証する
18. [Publisher reward live-money payout pilot gate](./docs/workers-coordinator-prototype.md) で、operator-controlled release switch、provider settlement callbacks、publisher receipt evidence、payout status transitions、emergency hold / rollback controls、recurring payout operations へ進む promote/hold thresholds を検証する
19. [Publisher reward recurring payout operations gate](./docs/workers-coordinator-prototype.md) で、idempotent scheduled payout windows、provider retry/backoff ledgers、publisher support dispute routing、accounting export reconciliation、post-pilot SLO/error-budget dashboards、payout ops revenue reporting へ進む promote/hold thresholds を検証する
20. [Publisher reward payout operations revenue reporting gate](./docs/workers-coordinator-prototype.md) で、publisher monthly statements、platform fee / Coordinator relay spend margin reconciliation、refund / reversal / clawback adjustments、audit-ready payout operations exports、tax reporting export へ進む promote/hold thresholds を検証する
21. [Publisher reward tax reporting / 1099-K export gate](./docs/workers-coordinator-prototype.md) で、publisher tax profiles、tax-year summaries、1099-K export records、revenue reporting / accounting export reconciliation、finance / operator review exports、tax filing drill へ進む promote/hold thresholds を検証する
22. [Publisher reward tax filing drill / publisher delivery gate](./docs/workers-coordinator-prototype.md) で、provider filing packet handoff、accepted / rejected filing attempt、retry evidence、publisher portal document delivery、corrected-form workflow、deadline alert、post-filing audit evidence、real provider sandbox run へ進む promote/hold thresholds を検証する
23. [Publisher tax filing real provider sandbox run gate](./docs/workers-coordinator-prototype.md) で、sandbox provider request / response ID、accepted / rejected submission、signed callback、publisher delivery evidence、corrected-form / post-filing audit reconciliation、production filing cutover readiness へ進む promote/hold thresholds を検証する
24. [Publisher tax filing production cutover readiness gate](./docs/workers-coordinator-prototype.md) で、sandbox provider filing IDs、operator approval evidence、production filing window、live-provider preflight evidence、duplicate-filing suppression、rollback / emergency hold controls、production callbacks readiness へ進む promote/hold thresholds を検証する
25. [Publisher tax filing production callbacks readiness gate](./docs/workers-coordinator-prototype.md) で、cutover approval evidence、production callback IDs、callback signature verification state、approved filing window reconciliation、duplicate-filing suppression、rollback / emergency hold controls、production monitoring reconciliation へ進む promote/hold thresholds を検証する
26. [Publisher tax filing production monitoring reconciliation gate](./docs/workers-coordinator-prototype.md) で、accepted / rejected / corrected / duplicate-suppressed callback streams、operator monitoring records、publisher monitoring exports、alert traceability、duplicate-filing suppression replay、rollback / emergency hold replay controls、exception operations runbook へ進む promote/hold thresholds を検証する
27. [Publisher tax filing production exception operations runbook gate (#91)](./docs/publisher-tax-production-exception-operations.md) で、rejected / corrected / duplicate-suppressed / replay-detected eventをoperator runbook actionへ変換し、monitoring alert / production callback / provider filing / approved production windowをsupport escalationへtraceする。affected provider filingごとのpublisher status update、duplicate-filing suppression維持、rollback / emergency-hold decision evidence、signed runner isolationを検証し、次の`publisher-tax-filing-production-exception-resolution-audit`へ進む
28. [Publisher tax filing production exception resolution audit gate (#116)](./docs/publisher-tax-production-exception-resolution-audit.md) で、各runbook actionをterminal `resolved`または明示的`carried-forward`へ収束させる。corrected filingのprovider outcome、support escalation resolution、publisher final/carry-forward status、original identity fingerprint、duplicate-filing suppression、rollback/emergency-hold identityを照合し、次の`publisher-tax-filing-production-exception-audit-archive-retention`へ進む
29. [Publisher tax filing production exception audit archive / retention gate (#118)](./docs/publisher-tax-production-exception-audit-archive-retention.md) で、resolution audit identityをversioned archive packageへ固定し、SHA-256 content digest、archive/provider retrieval proof、minimum retention window、carried-forward review obligation、legal/operational hold、auditable deletion review、signed runner isolationを照合する。gate自体は物理削除を行わず、次の`publisher-tax-filing-production-exception-archive-restore-drill`へ進む
30. [Publisher tax filing production exception archive restore / integrity drill gate (#121)](./docs/publisher-tax-production-exception-archive-restore-drill.md) で、primary archiveまたはbackup replicaから同一archive ID/schema/identity/digestを復元し、post-restore SHA-256 integrity check、backup recovery traceability、restore/integrity/backup access audit、retention/hold/deletion-review stateの不変性、signed runner isolationを照合する。次の`publisher-tax-filing-production-exception-archive-disaster-recovery-operations`へ進む
31. [Publisher tax filing production exception archive disaster recovery operations gate (#123)](./docs/publisher-tax-production-exception-archive-disaster-recovery-operations.md) で、restore drill cadence、RTO/RPO、backup age、replication lag、recovery ownership、incident escalation、archival-provider EvidenceEnvelope provenance、archive/retention identity不変性、signed runner isolationを照合する。breachはincidentが記録されていてもholdとし、次の`publisher-tax-filing-production-exception-archive-dr-provider-pilot`へ進む
32. [Publisher tax filing production exception archive DR provider pilot gate (#126)](./docs/publisher-tax-production-exception-archive-dr-provider-pilot.md) で、provider pilot evidenceを`captured-and-verified`かつ`verified-pilot`以上に限定し、artifact loader / SHA-256 / trusted independent verifier、primary/backup両retrieval、scheduled restore、RTO/RPO、backup age/replication lag、provider/account/storage/replica identity、retention/incident/ownership identity、signed runner isolationを照合する。一回のverified pilotをproduction approvalとは扱わず、次の`publisher-tax-filing-production-exception-archive-dr-provider-production-readiness`へ進む
33. [Publisher tax filing production exception archive DR provider production-readiness gate (#128)](./docs/publisher-tax-production-exception-archive-dr-provider-production-readiness.md) で、production-readiness evidenceを`captured-and-verified`かつ`production-candidate`以上に限定し、少なくとも3本の独立verified provider run / 2 restore windows、provider/account/storage/replica/archive identity、production restore window、two-person operator approval、monitoring/error budget、credential/signing/encryption key rotation、backup storageを実際に使ったfailover exercise、retention/incident/ownership identity、rollback/emergency-hold controls、signed runner isolationを照合する。readiness report自体は`production-approved`を主張せず、次の`publisher-tax-filing-production-exception-archive-dr-provider-production-cutover`へ進む
34. [Publisher tax filing production exception archive DR provider production cutover gate (#131)](./docs/publisher-tax-production-exception-archive-dr-provider-production-cutover.md) で、exact production-readiness evidence、production window/change-ticket/two-person approvals/credential-key identityにcutover authorizationを固定し、live provider operation/trace/restore execution、canonical archive ID/digest、post-cutover integrity、RTO/RPO、backup age/replication lag、immediate monitoring、rollback/emergency-hold armed state、retention/ownership/incident/security boundaryを照合する。contract fixtureのpassを実provider cutoverと表現せず、次の`publisher-tax-filing-production-exception-archive-dr-provider-post-cutover-reconciliation`へ進む
35. [Publisher tax filing production exception archive DR provider post-cutover reconciliation gate (#133)](./docs/publisher-tax-production-exception-archive-dr-provider-post-cutover-reconciliation.md) で、exact production cutover evidenceを再検証し、cutover完了後からimmediate monitoringを超えるobservation window、provider audit/log、primary/backup両archive再取得とdigest/integrity、alert/incident/control invocation reconciliation、rolling SLO/error budget、credential/key rotation期限、retention/ownership/security boundaryを照合する。contract fixtureのpassを実provider steady-state evidenceとは表現せず、次の`publisher-tax-filing-production-exception-archive-dr-provider-steady-state-operations`へ進む
36. [Publisher tax filing production exception archive DR provider steady-state operations gate (#135)](./docs/publisher-tax-production-exception-archive-dr-provider-steady-state-operations.md) で、exact post-cutover reconciliation evidenceを再検証し、3本以上の独立verified recurring cycle、schedule/cadence/grace/overdue、primary/backup両archive再取得とdigest/integrity、provider audit cursor continuity、rolling SLO/error budget、credential/signing/encryption key rotation、backup-source DR/failover exercise、alert/incident/control review、per-cycle operational evidence retention、retention/ownership/security boundaryを照合する。このgate自体はcycleを起動・収集しないため、次の`publisher-tax-filing-production-exception-archive-dr-provider-continuous-assurance-automation`へ進む
37. [Publisher tax filing production exception archive DR provider continuous assurance automation (#137)](./docs/publisher-tax-production-exception-archive-dr-provider-continuous-assurance-automation.md) で、#135のexact aggregate/cycle evidenceを再検証し、explicit `nowMs` からidle/due/overdueを決定する。provider audit、primary/backup retrieval、due credential/key rotation、due backup-source DR exercise、cycle evidence archive/capture、aggregate capture、operator pagingをdeterministic idempotency keyとbounded retryでオーケストレートし、最終判定を既存steady-state gateへ戻す。このpure orchestration contract自体は実schedulerをdeployしないため、次の`publisher-tax-filing-production-exception-archive-dr-provider-continuous-assurance-worker-runtime`へ進む
38. [Publisher tax filing production exception archive DR provider continuous assurance Worker runtime (#139)](./docs/publisher-tax-production-exception-archive-dr-provider-continuous-assurance-worker-runtime.md) で、`worker-runtime/continuous-assurance-worker.mjs` のCron `scheduled()`をdeterministic named SQLite Durable Objectへルーティングし、durable execution ledger、completed duplicate suppression、lease-based concurrent delivery suppression、interrupted replay、first-failure/paging separation、internal `ASSURANCE_ENGINE` Service BindingをMiniflare runtime smokeで検証する。`worker-runtime/wrangler.jsonc` は2026-08-20 compatibility date、`nodejs_compat`、Cron、SQLite DO migration、Service Binding、observabilityを定義する。ただしMiniflare passは実Cloudflare deployや実provider接続を証明しないため、次の`publisher-tax-filing-production-exception-archive-dr-provider-continuous-assurance-engine-service-deployment`へ進む
39. [Publisher tax filing production exception archive DR provider continuous assurance engine service (#141)](./docs/publisher-tax-production-exception-archive-dr-provider-continuous-assurance-engine-service.md) で、#139 `ASSURANCE_ENGINE` Service Binding先を実装し、exact verified #135 snapshot、SQLite engine journal、scope single-flight、interrupted replay、completed duplicate suppression、base aggregate run IDのatomic CAS、provider/evidence/pager Service Binding adapter、artifact load + trusted independent verifier、secret-protected bootstrapを検証する。#137 automationを唯一のpolicy engineとして再利用し、Miniflare passを実provider運用とは表現しない。次の`publisher-tax-filing-production-exception-archive-dr-provider-continuous-assurance-provider-adapter-canary`へ進む
40. [Publisher tax filing production exception archive DR provider continuous assurance provider adapter canary (#143)](./docs/publisher-tax-production-exception-archive-dr-provider-continuous-assurance-provider-adapter-canary.md) で、#141 engineの`PROVIDER_ADAPTER` / `EVIDENCE_ADAPTER` / `PAGER_ADAPTER` Service Binding先と独立verifierを実装し、provider idempotency、R2 artifact保存とSHA-256再計算、independent verifier、pager dedupe、`captured-and-verified` / `production-candidate` adapter canary gate、Miniflare multi-service配線を検証する。local contract/runtime passをactual Cloudflare deployや実provider canaryとは扱わず、次の`publisher-tax-filing-production-exception-archive-dr-provider-continuous-assurance-production-deployment-canary`へ進む
41. [Publisher tax filing production exception archive DR provider continuous assurance production deployment canary (#145)](./docs/publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-deployment-canary.md) で、Cloudflare Worker `version_metadata` とdeploy-time config fingerprintをcontroller/runtime/engine/provider/evidence/pager/verifierへ固定し、controller→runtime→同一SQLite DO `runScheduled()`→engine、engine-observed adapter Service Binding identity、R2 canary artifact、independent verifier、bad-secret/duplicate/digest/trust negative path、secret-redacted Wrangler deployment helperを検証する。このcanaryはnormal Cronと競合するprovider write/key rotation/DR exerciseを発行しないread-only `idle` tickに限定し、CI/Miniflare/dry-run passをactual Cloudflare deployment evidenceとは扱わない。次の`publisher-tax-filing-production-exception-archive-dr-provider-continuous-assurance-production-provider-canary`へ進む
42. [Publisher tax filing production exception archive DR provider continuous assurance production provider canary (#149)](./docs/publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-provider-canary.md) で、#145のexact deployment-canary evidenceを独立再検証し、bounded window/change ticket/two-person approval/exact action allowlistへprovider canary authorizationを固定する。許可actionはprovider health、audit read、primary/backup archive retrieval、pager canary + dedupeに限定し、key rotation/DR failover/archive mutationはdefault-denyする。R2 canonical artifact + dedicated independent verifierで`captured-and-verified` / `production-candidate` evidenceを作り、CI fixture passを実provider canaryとは扱わない。次の`publisher-tax-filing-production-exception-archive-dr-provider-continuous-assurance-production-operations-rollout`へ進む
43. [Publisher tax filing production exception archive DR provider continuous assurance production operations rollout (#152)](./docs/publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-operations-rollout.md) で、#149のexact verified provider-canary evidenceを再検証し、`observe-only`→`maintenance-enabled`→`dr-exercise-enabled`→`steady-state-enabled`の4 phaseをskip/reorder/overlapなしで進める。各phaseを独立`captured-and-verified` / `production-approved` evidence、phase-specific action-name allowlist/action budget、SLO/error budget、incident/alert/control、provider/archive/deployment identityで照合する。maintenanceのkey rotationは別authorization + due window、DR phaseはbackup storage経路とcanonical digestを必須とする。clean completion時はterminal `steady-state-enabled`、`bottlenecksToIssue: []`、next cycle/rotation/DR/retention/on-call/rollback等の`operationalObligations`を返し、新しいvalidator gateを自動的に増やさず継続運用へ移行する
44. ~~[Chrome Prompt API feasibility harness (#93)] 実ブラウザ計測~~ — **破棄（2026-08-06）**。実ブラウザ計測で、Chrome 150 stable / 153 Canary のいずれもフラグ・エンタープライズポリシー等の特別な設定なしには `window.ai`（Prompt API）が露出しないことを確認したため、Chrome Built-in AI 採用方針（#92/#93/#95/#100）ごと破棄。`browser-harness/`・`chrome-prompt-api-report.ts`・`ChromeLanguageModelBackend`・`browser-built-in-model.ts` は削除済み
45. [InferenceBackend / WorkerCapability 抽象化 (#94)](./docs/inference-backend-abstraction.md) で、segmented WebGPU・full-model・server-fallbackを同一capability routing inputとして扱う。`WorkerCapability` はversioned + runtime validated、`InferenceEvent` はstreaming/abort/context/prepare/errorを共通イベント化し、full-model backendは`SegmentExecutor`を装わずにregisterできる。旧Worker登録protocolは一時adapterで互換維持し、既存のsegmented route動作は変更しない（`browser-built-in-full-model` kindは抽象化として残るが、Chrome実装は破棄済み）

### 7.2 経済性の精緻化

- 30Bモデルでの実測値に基づくコスト再計算
- API需要調査(どの価格帯でどの程度の需要があるか)
- API販売単価の市場検証($0.001は仮置き)
- Worker報酬の適正水準
- RPMの実測(パイロットサイトでの検証)

### 7.3 未決定事項

- 具体的なAPI価格設定(実測後に決定)
- Worker報酬の分配方式
- 対応モデルのロードマップ(30B → 70B → ?)
- 法的整理(各国の規制対応、Coinhive前例の調査)
- セキュリティベンダー・ブラウザベンダーへの事前説明方針

### 7.4 検証項目(仮説段階)

以下は現時点で仮説・主観に留まっている主張。パイロット運用で検証する:

- ブロッカー耐性: オプトインモデルは実際にブロックされにくいか?
- オプトイン率: 現実のサイトで20-30%は達成可能か?
- ユーザー体験: バックグラウンド推論は実際に「影響最小」か?
- 低スペック端末: CPU推論・軽量タスクで実用的な参加が可能か?

### 7.5 ~~Chrome Prompt API feasibility のGo/No-Go記録（#93）~~ — 破棄

**2026-08-06 破棄。** Chrome Built-in AI / Prompt API は、実ブラウザ計測で
フラグ・エンタープライズポリシー等の特別な設定なしには `window.ai` が露出
しないことを確認したため、採用方針ごと破棄しました。

計測の記録（実測、2026-08-06）:

- Chrome 150.0.7871.188 stable / 153.0.7992.0 canary で検証
- `chrome://flags` で `prompt-api`（= Enabled Multilingual）と
  `optimization-guide-on-device-model`（= Enabled BypassPerfRequirement）を
  有効化しても `window.ai` は非露出
- サインイン済み・モデルダウンロード済み（4GB）の実プロファイルでも非露出
- エンタープライズポリシー `BuiltInAIAPIsEnabled=true` でも非露出
- いずれの環境でも API が無いため、ハーネスのシナリオ実行は不能
  （`not-applicable` なレポートのみ生成可能）

この結果は「設定不要で動くWeb収益化インフラ」の前提を満たさないため、
#92/#93/#95/#100 を破棄し、関連コード（harness・report schema・
ChromeLanguageModelBackend・descriptor）を削除しました。
`browser-built-in-full-model` kind は #94 の抽象化としてのみ残ります。

---

**ドキュメントバージョン**: 3.15
**作成日**: 2026年2月
**ステータス**: レビュー済み方針確定版
**変更履歴**:
- v3.15: #152 production operations rolloutを7.1項へ追加。#149のexact provider-canary evidenceからobserve-only / maintenance / DR / steady-stateの4 phaseを独立verified evidence・phase action allowlist・SLO/error budget・incident/control・identityで照合し、authorized key rotationとbackup-source DRを段階的に解禁。clean completionで`steady-state-enabled` + empty bottleneck list + operational obligationsを返し、validator chainをterminalにした
- v3.14: #149 production provider canaryを7.1項へ追加。#145 deployment-canary evidenceをexact revalidationし、two-person/time-bounded authorizationの下でhealth/audit/primary+backup retrieval/pager dedupeだけを許可。R2 artifact + dedicated verifier、destructive action default-denyを実装し、次のproduction operations rolloutを明示
- v3.13: #145 production exception archive DR provider continuous assurance production deployment canaryを7.1項へ追加。Worker version metadata/config fingerprint、read-only runtime→SQLite DO→engine wiring、engine-observed adapter identity、R2 artifact + independent verifier、negative-path checks、secret-redacted Wrangler deployment planを実装し、CI/Miniflare/dry-runをactual deployment evidenceと区別した上で次のproduction provider canaryを明示
- v3.12: #143 production exception archive DR provider continuous assurance provider adapter canaryを7.1項へ追加。provider/evidence/pager internal Workers、R2 artifact保存・SHA-256再計算、独立verifier Service Binding、pager dedupe、captured-and-verified / production-candidate canary gate、Miniflare multi-service wiringを実装し、次のproduction deployment canaryを明示
- v3.11: #141 production exception archive DR provider continuous assurance engine serviceを7.1項へ追加。#137 policy engine再利用、exact verified snapshot、SQLite engine journal、atomic base-run CAS、provider/evidence/pager Service Bindings、artifact load/independent verifier、secret-protected bootstrap、Miniflare replay/single-flight smokeを実装し、次のprovider adapter canaryを明示
- v3.10: #139 production exception archive DR provider continuous assurance Worker runtimeを7.1項へ追加。Cron scheduled handler、named SQLite Durable Object、durable execution ledger、duplicate/lease/replay semantics、internal Service Binding、Miniflare restart/concurrency/failure smoke、2026-08-20 Wrangler configを検証し、次のengine service deploymentを明示
- v3.9: #137 production exception archive DR provider continuous assurance automationを7.1項へ追加。explicit nowMs、idle/due/overdue、deterministic idempotency/retry、provider audit + primary/backup retrieval、due key rotation/DR exercise、verified cycle/aggregate capture、operator paging、steady-state gate再評価を実装し、次のdeployed worker runtimeを明示
- v3.8: #135 production exception archive DR provider steady-state operations gateを7.1項へ追加。3 verified recurring cycles、cadence/overdue、primary/backup archive integrity、audit cursor continuity、rolling SLO/error budget、credential/key rotation、backup-source DR exercise、alert/incident/control review、per-cycle evidence retentionを検証し、次のcontinuous-assurance automationを明示
- v3.7: #133 production exception archive DR provider post-cutover reconciliation gateを7.1項へ追加。longer observation、provider audit/log、primary/backup archive再取得、alert/incident/control reconciliation、SLO/error budget、credential/retention/security postureを検証し、次のsteady-state operationsを明示
- v3.6: #131 production exception archive DR provider production cutover gateを7.1項へ追加。exact readiness binding、bounded authorization/window、live provider operation、archive integrity、DR objectives、immediate monitoring、rollback/emergency-hold、identity/security preservationを検証し、次のpost-cutover reconciliationを明示
- v3.5: #128 production exception archive DR provider production-readiness gateを7.1項へ追加。3 verified runs / 2 restore windows、production restore window、two-person approval、monitoring/error budget、credential/key rotation、backup failover exerciseを検証し、次のprovider production cutoverを明示
- v3.4: #126 production exception archive DR provider pilot gateを7.1項へ追加。captured-and-verified / verified-pilot provenance、primary/backup retrieval、scheduled restore、DR objectives、provider/account/storage/replica identityを検証し、次のprovider production-readinessを明示
- v3.3: #123 production exception archive disaster recovery operations gateを7.1項へ追加。restore cadence、RTO/RPO、backup age/replication lag、ownership、incident escalation、provider evidence provenanceを検証し、次のarchive DR provider pilotを明示
- v3.2: #121 production exception archive restore / integrity drill gateを7.1項へ追加。primary/backupからのexact restore、post-restore SHA-256 integrity check、backup recovery、access audit、retention/hold/deletion state不変性を検証し、次のarchive disaster-recovery operationsを明示
- v3.1: #118 production exception audit archive / retention gateを7.1項へ追加。versioned archive identity、SHA-256 digest、retrieval proof、retention/hold/deletion reviewを検証し、次のarchive restore/integrity drillを明示
- v3.0: #116 production exception resolution audit gateを7.1項へ追加。runbook actionのresolved/carry-forward、corrected filing provider outcome、support/publisher resolution、immutable identity fingerprint、control integrityを検証し、次のexception audit archive/retentionを明示
- v2.9: #91 production exception operations runbook gateを7.1項へ追加。monitoring exceptionからoperator action / support escalation / publisher status / duplicate suppression / rollback-hold decisionをtraceし、次のexception resolution auditを明示。#103 durability記述をDurableObjectRepository実装後の状態へ更新
- v2.8: Chrome Built-in AI / Prompt API 採用方針（#92/#93/#95/#100）を破棄。実ブラウザ計測で特別な設定なしにはAPIが露出しないことを確認（7.5項に記録）。関連コード削除済み
- v2.7: InferenceBackend / `WorkerCapability`抽象化（#94）を7.1項に追加。segmented・full-model・server-fallbackを同一capabilityでroutingする方針と、full-model backendが`SegmentExecutor`を装わないことを明記（詳細は[`docs/inference-backend-abstraction.md`](./docs/inference-backend-abstraction.md)）
- v2.0: 初版(旧文書の矛盾解消、方針確定)
- v2.1: 通信ポリシー明確化、RPMポジション修正、信頼性3シナリオ化、公平性配慮追加
- v2.2: 目的定義の表現統一、安全境界の多層防御設計追加、経済性の仮定明示強化、置換条件の時期断定削除、公平性の具体策追加、検証項目の分離
- v2.3: 攻撃者モデル明示、安全境界の適用スコープ(iframe/worker/origin)定義、RPM感度分析の独立変数前提と変数間相関の注記、CPU推論参加の実務制約追記、「広告依存脱却」→「広告依存度低減」に表現統一
- v2.4: CSP script-srcのPoC検証注記追加、攻撃者モデルのMITM/Coordinator侵害分離(侵害は運用セキュリティとして別途)、PV影響を仮説扱いに変更(7.4リンク)、広告依存度低減のスコープを4.2にリンク、広告ブロッカー利用率を推定値扱いに
- v2.5: CSPドメイン例を環境変数化(prod/staging/dev差し替え前提)、Wasm/blob CSP許可の判断基準を「PoCで不足確認時のみ追加」に明確化、PV影響の表現を簡潔に(仮説+※2参照)
- v2.6: 長時間ワーカー戦略(4.5項)を追加。OBSブラウザソース・ブラウザ拡張・Electron等の長時間稼働アプリケーションをワーカーとして活用する視点。経済性・信頼性・ハイブリッド戦略・技術的制約を記載。レビュー反映: タイトルv2→v2.6に統一、収益比較を月間ベースに統一、単一ノード連続処理のトレードオフ(レイテンシ/冗長性)追記、MV3 Service Worker制約の厳格化(失敗時挙動・成立条件・代替策)、GPU競合表現の修正
**前提**: 旧LLM関連文書(README.md, cost-calculation系)の矛盾を解消し、確定した方針のみ記載