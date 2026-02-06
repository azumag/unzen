# 参考文献・関連論文まとめ

unzen (QJS-proto) の実装に関連する学術論文・技術文献の整理。

**注**: 自己消費モデル (v3.0) への移行に伴い、セクション4-6 (BFT合意、P2P、ゴシップ) は
現在の設計では直接使用しない。歴史的参考として残すが、実装優先度は低い。

## カテゴリー別索引

### 現在の設計に直接関連
1. [WebAssemblyセキュリティ](#1-webassemblyセキュリティ)
2. [JavaScriptランタイム・サンドボックス](#2-javascriptランタイムサンドボックス)
3. [ブラウザベース計算の先行研究](#3-ブラウザベース計算の先行研究)

### 歴史的参考 (旧分散モデル用)
4. [合意形成・BFTアルゴリズム](#4-合意形成bftアルゴリズム)
5. [P2P通信・WebRTC](#5-p2p通信webrtc)
6. [ゴシッププロトコル・メンバーシップ管理](#6-ゴシッププロトコルメンバーシップ管理)

---

## 1. WebAssemblyセキュリティ

> unzenのコア技術。サンドボックスの安全性保証に直接関連。

### 1.1 Provably-Safe Multilingual Software Sandboxing using WebAssembly (2022)
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

### 1.2 WaVe: A Verifiably Secure WebAssembly Sandboxing Runtime (2023)
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

### 1.3 WebAssembly and Security: A Review (2025)
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

### 1.4 Isolation without Taxation (2021)
- **著者**: Matthew Kolosick et al. (UC San Diego, Intel Labs)
- **発表**: ACM Transactions on Computer Systems
- **重要度**: ★★★★☆
- **概要**:
  WebAssemblyとSFI（Software-based Fault Isolation）の境界コストをほぼゼロにする手法。Mozilla/Firefoxでの実装経験も含む。
- **unzenとの関連**:
  - 低コストなサンドボックス切り替え
  - ホスト→Wasmの呼び出しコスト最小化
  - Firefoxでの実装ノウハウ

### 1.5 An Empirical Study of WebAssembly Usage in Node.js (2026)
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

## 2. JavaScriptランタイム・サンドボックス

> QuickJS Wasm サンドボックスの設計・実装に直接関連。

### 2.1 NatiSand: Native Code Sandboxing for JavaScript Runtimes (2023)
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

### 2.2 An Empirical Study of Lightweight JavaScript Engines (2023)
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

### 2.3 Automated Analysis of Security-Critical JavaScript APIs (2011)
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

## 3. ブラウザベース計算の先行研究

> 直接的な実装参考ではないが、ブラウザでの計算実行の先行知見として有用。

### 3.1 Distributed Computing on an Ensemble of Browsers (2013)
- **著者**: Cushing et al.
- **発表**: IEEE Internet Computing 17(5)
- **URL**: https://www.researchgate.net/publication/260305213
- **重要度**: ★★★☆☆ (旧: ★★★★★)
- **概要**:
  Webブラウザの集合体を用いた分散コンピューティングの先駆的研究。タブを閉じるなどの不安定性に対処するための重複実行戦略を提案。
- **unzenとの関連**:
  - ブラウザ環境の制約（バックグラウンド停止など）への知見
  - フォールバック機構の設計に参考

### 3.2 MLitB: Machine Learning in the Browser (2015)
- **著者**: Edward Meeds et al.
- **発表**: PeerJ Computer Science
- **DOI**: 10.7717/peerj-cs.11
- **重要度**: ★★★☆☆ (旧: ★★★★☆)
- **概要**:
  Webブラウザ上での機械学習計算を行う分散システム。WebWorkerと並列処理を活用。
- **unzenとの関連**:
  - WebWorkerを使ったブラウザ内計算の実装パターン

---

## 4. 合意形成・BFTアルゴリズム

> **注: 自己消費モデルでは不使用**。旧Dispatcher分散モデル用。歴史的参考。

### 4.1 Practical Byzantine Fault Tolerance (1999) - オリジナル論文
- **著者**: Miguel Castro, Barbara Liskov (MIT)
- **発表**: OSDI '99
- **URL**: https://pmg.csail.mit.edu/papers/osdi99.pdf

### 4.2 Practical Byzantine Fault Tolerance and Proactive Recovery (2002)
- **著者**: Miguel Castro, Barbara Liskov
- **発表**: ACM Transactions on Computer Systems
- **URL**: https://pmg.csail.mit.edu/papers/bft-tocs.pdf

### 4.3 Reaching Consensus in the Byzantine Empire (2024)
- **著者**: Gengrui Zhang et al. (University of Toronto)
- **発表**: ACM Computing Surveys
- **URL**: https://arxiv.org/pdf/2204.03181v2.pdf

### 4.4 The Bedrock of Byzantine Fault Tolerance (2024)
- **著者**: Mohammad Javad Amiri et al. (Stony Brook, UPenn, UCSB)
- **発表**: NSDI '24
- **URL**: https://www.usenix.org/system/files/nsdi24-amiri.pdf

### 4.5 A Hierarchical Byzantine Fault Tolerance Consensus for IoT (2024)
- **著者**: Rongxin Guo et al.
- **発表**: High-Confidence Computing
- **DOI**: 10.1016/j.hcc.2023.100196

---

## 5. P2P通信・WebRTC

> **注: 自己消費モデルでは不使用**。旧分散モデル用。歴史的参考。

### 5.1 Snowflake: Censorship Circumvention using WebRTC (2024)
- **著者**: Cecylia Bocovich et al. (Tor Project)
- **発表**: USENIX Security Symposium
- **URL**: https://www.usenix.org/system/files/sec24fall-prepub-1998-bocovich.pdf

### 5.2 An Adaptive Peer-Sampling Protocol for Browser Networks (2018)
- **著者**: Achour Mostéfaoui
- **発表**: World Wide Web Journal
- **DOI**: 10.1007/s11280-017-0478-5

### 5.3 SnoW: Serverless n-Party Calls over WebRTC (2022)
- **著者**: Thomas Sandholm
- **URL**: https://arxiv.org/abs/2206.12762

### 5.4 BrowserCloud.js (2018)
- **著者**: David Dias, Luís Veiga (ULisboa)
- **発表**: ACM SAC 2018
- **DOI**: 10.1145/3167132.3167366

---

## 6. ゴシッププロトコル・メンバーシップ管理

> **注: 自己消費モデルでは不使用**。旧分散モデル用。歴史的参考。

### 6.1 SWIM (2002)
- **著者**: Das, Gupta, Motivala (Cornell)
- **URL**: https://www.cs.cornell.edu/projects/Quicksilver/public_pdfs/SWIM.pdf

### 6.2 Gossip-Based Computation of Aggregate Information (2003)
- **著者**: Kempe, Dobra, Gehrke (Cornell)
- **URL**: https://www.cs.cornell.edu/johannes/papers/2003/focs2003-gossip.pdf

### 6.3 Gossip-based Aggregation in Large Dynamic Networks (2005)
- **著者**: Jelasity, Montresor, Babaoglu (Bologna)
- **URL**: https://cs.unibo.it/babaoglu/papers/pdf/acm-tocs-2005.pdf

### 6.4 Lightweight Probabilistic Broadcast (2003)
- **著者**: Eugster et al. (EPFL, Microsoft Research)
- **URL**: https://infoscience.epfl.ch/record/52369/files/IC_TECH_REPORT_200102.pdf

---

## 実装優先度マトリクス

| 論文 | カテゴリー | 実装フェーズ | 優先度 |
|------|-----------|------------|--------|
| Bosamiya et al. (2022) | Wasmセキュリティ | Phase 1 (MVP) | 最高 |
| NatiSand (2023) | JSサンドボックス | Phase 1 (MVP) | 高 |
| Lightweight JS Engines (2023) | QuickJS評価 | Phase 1 | 高 |
| Isolation without Taxation (2021) | Wasm最適化 | Phase 3 | 中 |
| Cushing et al. (2013) | ブラウザ計算 | 参考のみ | 低 |

---

## 読み進めガイド

### Phase 1: MVP（サンドボックス構築）
1. **Provably-Safe Multilingual Sandboxing** - Wasmサンドボックス設計の基本
2. **NatiSand** - 多層サンドボックスの実装パターン
3. **Lightweight JS Engines** - QuickJSの特性とトレードオフ

### Phase 2: 最適化
1. **Isolation without Taxation** - パフォーマンス最適化
2. **Wasm in Node.js** - JS/Wasm相互運用パターン

---

**最終更新**: 2026年2月
**作成者**: unzen 開発チーム
