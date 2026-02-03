# 参考文献・関連論文まとめ

unzen (QJS-proto) の実装に関連する学術論文・技術文献の整理。

## カテゴリー別索引

1. [ブラウザベース分散コンピューティング](#1-ブラウザベース分散コンピューティング)
2. [WebAssemblyセキュリティ](#2-webassemblyセキュリティ)
3. [合意形成・BFTアルゴリズム](#3-合意形成bftアルゴリズム)
4. [P2P通信・WebRTC](#4-p2p通信webrtc)
5. [ゴシッププロトコル・メンバーシップ管理](#5-ゴシッププロトコルメンバーシップ管理)
6. [JavaScriptランタイム・サンドボックス](#6-javascriptランタイムサンドボックス)

---

## 1. ブラウザベース分散コンピューティング

### 1.1 Distributed Computing on an Ensemble of Browsers (2013)
- **著者**: Cushing et al.
- **発表**: IEEE Internet Computing 17(5)
- **URL**: https://www.researchgate.net/publication/260305213
- **重要度**: ★★★★★
- **概要**: 
  Webブラウザの集合体を用いた分散コンピューティングの先駆的研究。タブを閉じるなどの不安定性に対処するための重複実行戦略を提案。
- **unzenとの関連**:
  - Workerの不安定性を前提とした重複実行モデル
  - ブラウザ環境の制約（バックグラウンド停止など）への対処方法
  - 結果検証の必要性の実証

### 1.2 MLitB: Machine Learning in the Browser (2015)
- **著者**: Edward Meeds et al.
- **発表**: PeerJ Computer Science
- **DOI**: 10.7717/peerj-cs.11
- **重要度**: ★★★★☆
- **概要**:
  Webブラウザ上での機械学習計算を行う分散システム。WebWorkerと並列処理を活用。
- **unzenとの関連**:
  - WebWorkerを使ったブラウザ内並列処理の実装パターン
  - タスク分割と結果集約のアプローチ

### 1.3 Genet: WebRTC-based Volunteer Computing (2019)
- **著者**: Erick Lavoie, Laurie Hendren et al.
- **発表**: arXiv:1904.11402
- **URL**: https://arxiv.org/abs/1904.11402
- **重要度**: ★★★★★
- **概要**:
  WebRTCを用いたブラウザ間直接通信によるfat-treeトポロジーの実装。コネクション数の制限を子ノードへの接続で解決。
- **unzenとの関連**:
  - WebRTC DataChannelを使ったWorker間直接通信
  - Fat-treeオーバーレイによるスケーリング戦略
  - ブラウザの接続数制限（TCP）への対処法

### 1.4 BOINC: A Platform for Volunteer Computing (2019)
- **著者**: David P. Anderson
- **発表**: Journal of Grid Computing
- **URL**: https://link.springer.com/content/pdf/10.1007/s10723-019-09497-9.pdf
- **重要度**: ★★★★☆
- **概要**:
  ボランティアコンピューティングの代表的ミドルウェアBOINCの詳細解説。機器の異種性、信頼性不足、離脱（churn）への対処。
- **unzenとの関連**:
  - Workerの信頼性スコアリングシステム
  - チェックポイント/リスタート機構
  - 異種デバイス環境でのタスク配分

### 1.5 Web-based Volunteer Distributed Computing for Urgent Workloads (2022)
- **著者**: Nick Brown, Simon Newby
- **発表**: arXiv:2212.13981
- **URL**: https://arxiv.org/abs/2212.13981
- **重要度**: ★★★☆☆
- **概要**:
  時間制約の厳しいワークロードをブラウザベースのボランティアコンピューティングで処理する研究。
- **unzenとの関連**:
  - 時間重要なタスクのスケジューリング戦略
  - フォールバック機構の重要性

---

## 2. WebAssemblyセキュリティ

### 2.1 Provably-Safe Multilingual Software Sandboxing using WebAssembly (2022)
- **著者**: Jay Bosamiya, Wen Shih Lim, Bryan Parno (CMU)
- **発表**: USENIX Security Symposium
- **URL**: https://www.usenix.org/conference/usenixsecurity22/presentation/bosamiya
- **重要度**: ★★★★★
- **概要**:
  WebAssemblyによる多言語ソフトウェアのサンドボックス化を形式的に検証。数学的証明とRustによる実装の2つのアプローチ。
- **unzenとの関連**:
  - WebAssemblyサンドボックスの安全性保証
  - 高レベル言語からのコンパイル時の安全性維持
  - ハイパーバイザー不要の軽量隔離

### 2.2 WaVe: A Verifiably Secure WebAssembly Sandboxing Runtime (2023)
- **著者**: [IEEE S&P関連]
- **発表**: IEEE Symposium on Security and Privacy
- **DOI**: 10.1109/SP46215.2023.00179
- **重要度**: ★★★★★
- **概要**:
  形式的検証されたWebAssemblyサンドボックスランタイム。線形型理論を用いてWasmモジュールの安全性を保証。
- **unzenとの関連**:
  - サンドボックス実装の形式的検証アプローチ
  - メモリ安全の保証
  - 実用性と安全性の両立

### 2.3 WebAssembly and Security: A Review (2025)
- **著者**: Gaetano Perrone, Simon Pietro Romano
- **発表**: Computer Science Review (Elsevier)
- **DOI**: 10.1016/j.cosrev.2025.100728
- **重要度**: ★★★★☆
- **概要**:
  WebAssemblyのセキュリティに関する包括的なレビュー。224の参考文献を含む。
- **unzenとの関連**:
  - Wasmセキュリティの脅威モデル
  - 既知の攻撃ベクトルと対策
  - サンドボックスの限界

### 2.4 Isolation without Taxation (2021)
- **著者**: Matthew Kolosick et al. (UC San Diego, Intel Labs)
- **発表**: ACM Transactions on Computer Systems
- **重要度**: ★★★★☆
- **概要**:
  WebAssemblyとSFI（Software-based Fault Isolation）の境界コストをほぼゼロにする手法。Mozilla/Firefoxでの実装経験も含む。
- **unzenとの関連**:
  - 低コストなサンドボックス切り替え
  - ホスト→Wasmの呼び出しコスト最小化
  - Firefoxでの実装ノウハウ

### 2.5 An Empirical Study of WebAssembly Usage in Node.js (2026)
- **著者**: Michelle Thalakottur et al. (Northeastern, Dartmouth, Google, CISPA)
- **発表**: ICSE 2026
- **URL**: https://www.software-lab.org/publications/icse2026_Wasm-JS.pdf
- **重要度**: ★★★☆☆
- **概要**:
  Node.jsエコシステムにおけるWebAssemblyの実態調査。JavaScriptとの相互作用の分析。
- **unzenとの関連**:
  - JS/Wasm相互運用のパフォーマンス特性
  - 実世界での使用パターン

---

## 3. 合意形成・BFTアルゴリズム

### 3.1 Practical Byzantine Fault Tolerance (1999) - オリジナル論文
- **著者**: Miguel Castro, Barbara Liskov (MIT)
- **発表**: OSDI '99
- **URL**: https://pmg.csail.mit.edu/papers/osdi99.pdf
- **重要度**: ★★★★★
- **概要**:
  PBFTアルゴリズムのオリジナル論文。非同期環境（インターネット）で動作する実用的なBFTアルゴリズムを初めて実装。
- **unzenとの関連**:
  - 3段階の合意形成プロトコル（Pre-prepare, Prepare, Commit）
  - ビザンチン耐性の条件（3f+1ノードでf個の故障まで許容）
  - ビュー変更（View Change）プロトコル

### 3.2 Practical Byzantine Fault Tolerance and Proactive Recovery (2002)
- **著者**: Miguel Castro, Barbara Liskov
- **発表**: ACM Transactions on Computer Systems
- **URL**: https://pmg.csail.mit.edu/papers/bft-tocs.pdf
- **重要度**: ★★★★★
- **概要**:
  PBFTに「予防的復旧（Proactive Recovery）」を追加。攻撃者が複数のレプリカを侵害しても継続的な安全性を保証。
- **unzenとの関連**:
  - Workerの信頼性スコアが低下した場合の自動再起動
  - 定期的なWorker交代による長期セキュリティ

### 3.3 Reaching Consensus in the Byzantine Empire (2024)
- **著者**: Gengrui Zhang et al. (University of Toronto)
- **発表**: ACM Computing Surveys
- **URL**: https://arxiv.org/pdf/2204.03181v2.pdf
- **重要度**: ★★★★☆
- **概要**:
  BFTコンセンサスアルゴリズムの包括的レビュー。HotStuff, Streamletなど最新アルゴリズムも含む。
- **unzenとの関連**:
  - 最新のBFTアルゴリズム比較
  - レイテンシとスループットのトレードオフ
  - ブロックチェーン向け最適化技術の適用可能性

### 3.4 The Bedrock of Byzantine Fault Tolerance (2024)
- **著者**: Mohammad Javad Amiri et al. (Stony Brook, UPenn, UCSB)
- **発表**: NSDI '24
- **URL**: https://www.usenix.org/system/files/nsdi24-amiri.pdf
- **重要度**: ★★★☆☆
- **概要**:
  BFTプロトコルの統一的な分析・実装・実験プラットフォーム。
- **unzenとの関連**:
  - 複数BFTアルゴリズムの実装パターン
  - パフォーマンス評価方法論

### 3.5 A Hierarchical Byzantine Fault Tolerance Consensus for IoT (2024)
- **著者**: Rongxin Guo et al.
- **発表**: High-Confidence Computing
- **DOI**: 10.1016/j.hcc.2023.100196
- **重要度**: ★★★☆☆
- **概要**:
  IoT環境向けの階層型BFTプロトコル。リソース制約環境での効率性を重視。
- **unzenとの関連**:
  - リソース制約環境（モバイルブラウザ等）でのBFT最適化
  - 階層的な合意形成

---

## 4. P2P通信・WebRTC

### 4.1 Snowflake: Censorship Circumvention using WebRTC (2024)
- **著者**: Cecylia Bocovich et al. (Tor Project)
- **発表**: USENIX Security Symposium
- **URL**: https://www.usenix.org/system/files/sec24fall-prepub-1998-bocovich.pdf
- **重要度**: ★★★★★
- **概要**:
  WebRTCを用いた検閲回避システム。多数の一時的なブラウザプロキシ（「スノーフレーク」）を使用。
- **unzenとの関連**:
  - WebRTCを使った大量のブラウザノード管理
  - NAT越え（STUN/TURN）の実装
  - 一時的なブラウザ参加者の信頼性管理

### 4.2 An Adaptive Peer-Sampling Protocol for Browser Networks (2018)
- **著者**: Achour Mostéfaoui
- **発表**: World Wide Web Journal
- **DOI**: 10.1007/s11280-017-0478-5
- **重要度**: ★★★★☆
- **概要**:
  ブラウザネットワーク向けの適応的ピアサンプリングプロトコル「Spray」。WebRTCの接続制限に対応。
- **unzenとの関連**:
  - ブラウザ間のピア発見アルゴリズム
  - 動的なメンバーシップ管理
  - WebRTCの接続数制限への対処

### 4.3 SnoW: Serverless n-Party Calls over WebRTC (2022)
- **著者**: Thomas Sandholm
- **発表**: arXiv:2206.12762
- **URL**: https://arxiv.org/abs/2206.12762
- **重要度**: ★★★☆☆
- **概要**:
  メディアサーバー不要のWebRTC多人数通信システム。Mesh/SFU/MCU相当のトポロジーをP2Pで構築。
- **unzenとの関連**:
  - 多対多のP2P通信トポロジー
  - リソース制限デバイスへの配慮

### 4.4 BrowserCloud.js (2018)
- **著者**: David Dias, Luís Veiga (ULisboa)
- **発表**: ACM SAC 2018
- **DOI**: 10.1145/3167132.3167366
- **重要度**: ★★★★☆
- **概要**:
  ブラウザをクラウドコンピューティングリソースとして統合するフレームワーク。
- **unzenとの関連**:
  - ブラウザリソースの抽象化
  - タスクスケジューリング

---

## 5. ゴシッププロトコル・メンバーシップ管理

### 5.1 SWIM: Scalable Weakly-consistent Infection-style Process Group Membership (2002)
- **著者**: Abhinandan Das, Indranil Gupta, Ashish Motivala (Cornell)
- **発表**: Cornell CS Technical Report
- **URL**: https://www.cs.cornell.edu/projects/Quicksilver/public_pdfs/SWIM.pdf
- **重要度**: ★★★★★
- **概要**:
  大規模分散システム向けのメンバーシッププロトコル。従来のheartbeat（二次関数的コスト）を改善し、感染型（gossip）でスケーラブルな故障検出を実現。
- **unzenとの関連**:
  - Worker（ブラウザ）の生死監視
  - O(n)のメッセージコストで大規模グループ管理
  - 間接的な故障検出（Suspicionメカニズム）

### 5.2 Gossip-Based Computation of Aggregate Information (2003)
- **著者**: David Kempe, Alin Dobra, Johannes Gehrke (Cornell)
- **発表**: FOCS 2003
- **URL**: https://www.cs.cornell.edu/johannes/papers/2003/focs2003-gossip.pdf
- **重要度**: ★★★★☆
- **概要**:
  ゴシッププロトコルを用いた集計計算（平均、合計、カウントなど）の理論的分析。
- **unzenとの関連**:
  - システム全体のWorker数推定
  - 平均負荷などのグローバル情報収集
  - 理論的保証のある集計アルゴリズム

### 5.3 Gossip-based Aggregation in Large Dynamic Networks (2005)
- **著者**: Márk Jelasity, Alberto Montresor, Ozalp Babaoglu (Bologna)
- **発表**: ACM TOCS
- **URL**: https://cs.unibo.it/babaoglu/papers/pdf/acm-tocs-2005.pdf
- **重要度**: ★★★★☆
- **概要**:
  大規模動的ネットワークにおけるゴシップベース集計の詳細な分析。対数収束と安定性の証明。
- **unzenとの関連**:
  - 動的なWorker参加/離脱環境での集計
  - 収束速度の理論的境界

### 5.4 Lightweight Probabilistic Broadcast (2003)
- **著者**: Patrick Th. Eugster et al. (EPFL, Microsoft Research)
- **発表**: EPFL Technical Report
- **URL**: https://infoscience.epfl.ch/record/52369/files/IC_TECH_REPORT_200102.pdf
- **重要度**: ★★★☆☆
- **概要**:
  大規模P2Pシステム向けの軽量確率的ブロードキャストプロトコル。
- **unzenとの関連**:
  - ディスパッチャー間の情報伝播
  - スケーラブルなメッセージング

---

## 6. JavaScriptランタイム・サンドボックス

### 6.1 NatiSand: Native Code Sandboxing for JavaScript Runtimes (2023)
- **著者**: Marco Abbadini et al. (University of Bergamo)
- **発表**: RAID 2023
- **URL**: https://cs.unibg.it/seclab-papers/2023/RAID/natisand.pdf
- **重要度**: ★★★★★
- **概要**:
  Node.js/Deno/BunなどのJavaScriptランタイムでのネイティブコードサンドボックス化。seccomp-bpfと名前空間を使用。
- **unzenとの関連**:
  - JavaScriptランタイムのセキュリティ強化
  - 多層サンドボックス戦略
  - 実装パターン

### 6.2 An Empirical Study of Lightweight JavaScript Engines (2023)
- **著者**: Meng Wu et al.
- **発表**: IEEE QRS 2023
- **DOI**: 10.1109/QRS-C60940.2023.00103
- **重要度**: ★★★★☆
- **概要**:
  QuickJS, JerryScript, MuJSなどの軽量JavaScriptエンジンの実証的評価。メモリ使用量、起動時間、実行速度の比較。
- **unzenとの関連**:
  - QuickJSの特性把握
  - ブラウザ環境に適したエンジン選定
  - 軽量性とパフォーマンスのトレードオフ

### 6.3 Automated Analysis of Security-Critical JavaScript APIs (2011)
- **著者**: Ankur Taly et al. (Stanford, Google)
- **発表**: Research paper
- **URL**: https://research.google.com/pubs/archive/37199.pdf
- **重要度**: ★★★☆☆
- **概要**:
  JavaScript APIのセキュリティ分析。信頼できないコードからの安全なAPI設計。
- **unzenとの関連**:
  - 許可API設計のガイドライン
  - リファレンスモニターの実装

---

## 実装優先度マトリクス

| 論文 | カテゴリー | 実装フェーズ | 優先度 |
|------|-----------|------------|--------|
| Castro & Liskov PBFT (1999) | BFT | Phase 2 (分散実行) | 最高 |
| Bosamiya et al. (2022) | Wasmセキュリティ | Phase 1 (MVP) | 最高 |
| SWIM (2002) | メンバーシップ | Phase 1 (MVP) | 高 |
| Genet/WebRTC (2019) | P2P | Phase 2 | 高 |
| Cushing et al. (2013) | ブラウザ分散 | Phase 1 | 高 |
| NatiSand (2023) | JSサンドボックス | Phase 1 | 高 |
| Snowflake (2024) | WebRTC | Phase 2 | 中 |
| LightweightConsensus | BFT | Phase 2 | 中 |
| Isolation without Taxation (2021) | Wasm最適化 | Phase 3 | 中 |

---

## 読み進めガイド

### Phase 1: MVP（基礎実装）
1. **Provably-Safe Multilingual Sandboxing** - Wasmサンドボックス設計の基本
2. **SWIM** - Worker監視メカニズム
3. **Cushing et al.** - ブラウザ分散システムの一般的アプローチ
4. **NatiSand** - 多層サンドボックスの実装パターン

### Phase 2: 分散実行
1. **PBFT (Castro & Liskov)** - 合意形成アルゴリズムの基本
2. **Genet** - WebRTCを使ったWorker間通信
3. **Snowflake** - 大量の不安定なブラウザノード管理
4. **Practical BFT and Proactive Recovery** - 長期運用時のセキュリティ

### Phase 3: 高度化
1. **Reaching Consensus in the Byzantine Empire** - 最新BFTアルゴリズム調査
2. **Gossip-based Aggregation** - グローバル状態推定
3. **Isolation without Taxation** - パフォーマンス最適化
4. **An Empirical Study of Wasm** - 実世界での使用パターン

---

**最終更新**: 2026年2月  
**作成者**: unzen 開発チーム
