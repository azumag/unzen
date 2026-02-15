> **[ARCHIVED] このドキュメントは無効です**
>
> 廃止日: 2026-02-06
> 理由: 自己消費モデルへの移行により、分散ディスパッチャーの設計は不要になった
> 代替: core/docs/design.md (v3.0)
>
> このファイルはプロジェクト方針変更により無効となりました。
> 歴史的参考のためにのみ保管されています。内容に基づいて意思決定しないでください。

---

# 分散ディスパッチャー設計

unzen core のディスパッチャー層を分散化し、単一障害点（SPOF）を排除するためのアーキテクチャ設計。

## 1. 現状の課題

現在の設計では、中央集権的なディスパッチャーが存在し、以下のリスクがある：

- **単一障害点（SPOF）**: ディスパッチャーが停止するとシステム全体が停止
- **地理的レイテンシ**: 遠方のクライアントはディスパッチャーまでの距離が長い
- **スケーリング限界**: 1つのディスパッチャーの処理能力に上限
- **DDoS脆弱性**: ディスパッチャーが攻撃の直接的な標的

## 2. 分散ディスパッチャー構成パターン

### 2.1 パターンA: マルチマスター・ディスパッチャー（推奨）

```
┌─────────────────────────────────────────────────────────────┐
│                     エントリーポイント層（Anycast）              │
│           Cloudflare / AWS Global Accelerator               │
└──────────────────────────┬──────────────────────────────────┘
                           │
           ┌───────────────┼───────────────┐
           │               │               │
┌──────────▼──────┐ ┌──────▼──────┐ ┌──────▼──────┐
│  Dispatcher A   │ │  Dispatcher B │ │  Dispatcher C │
│   (Tokyo)       │ │   (NY)        │ │  (London)     │
└──────────┬──────┘ └──────┬──────┘ └──────┬──────┘
           │               │               │
           └───────────────┼───────────────┘
                           │
┌──────────────────────────▼────────────────────────────────────┐
│                   共有状態層（分散ストレージ）                    │
│         Redis Cluster / etcd / Cassandra                      │
│    ┌────────────┐  ┌────────────┐  ┌────────────┐            │
│    │ Shard 1    │  │ Shard 2    │  │ Shard 3    │            │
│    │ (Tokyo)    │  │ (NY)       │  │ (London)   │            │
│    └────────────┘  └────────────┘  └────────────┘            │
└─────────────────────────────────────────────────────────────────┘
                           │
          ┌────────────────┼────────────────┐
          │                │                │
┌─────────▼────────┐ ┌────▼─────┐ ┌────────▼─────────┐
│   Worker Pool    │ │ Worker   │ │   Worker Pool    │
│   (Asia)         │ │ Pool     │ │   (Europe)       │
│                  │ │ (US)     │ │                  │
└──────────────────┘ └──────────┘ └──────────────────┘
```

**特徴:**
- 地理的に分散した3つのマスターディスパッチャー
- Anycast DNSで最寄りのディスパッチャーにルーティング
- Redis ClusterでWorker状態・実行中タスクを同期
- 各ディスパッチャーは独立してWorkerを管理しつつ、他のディスパッチャーと情報共有

### 2.2 パターンB: DHTベースのディスパッチャー選定

```
┌────────────────────────────────────────────────────────────┐
│                   クライアントリクエスト                      │
└──────────────────────────┬─────────────────────────────────┘
                           │
           ┌───────────────┴───────────────┐
           │    Kademlia DHT Lookup        │
           │   (Request ID → Dispatcher)   │
           └───────────────┬───────────────┘
                           │
    ┌──────────────────────┼──────────────────────┐
    │                      │                      │
┌───▼───┐            ┌────▼────┐           ┌────▼────┐
│Disp.  │◄──────────►│  Disp.  │◄─────────►│  Disp.  │
│A      │   gossip   │   B     │   gossip  │   C     │
└───┬───┘            └────┬────┘           └────┬────┘
    │                     │                      │
    │    ┌────────────────┼────────────────┐    │
    │    │                │                │    │
┌───▼────▼───┐     ┌──────▼─────┐   ┌──────▼────▼───┐
│ Worker Mesh│     │ Worker Mesh│   │ Worker Mesh   │
│ (Region A) │     │ (Region B) │   │ (Region C)    │
└────────────┘     └────────────┘   └───────────────┘
```

**特徴:**
- Kademlia DHTを使用して、リクエストIDに基づき責任ディスパッチャーを決定
- 同じリクエストは常に同じディスパッチャー（群）にルーティング
- ディスパッチャー間はgossip protocolでWorkerプール情報を共有
- ハッシュリングによる一貫性のある負荷分散

### 2.3 パターンC: P2Pコンセンサス・ディスパッチャー

```
┌──────────────────────────────────────────────────────────┐
│                 リクエストを受信                          │
└──────────────────────┬───────────────────────────────────┘
                       │
         ┌─────────────┴──────────────┐
         │   3つのディスパッチャー同時選定  │
         │     (Raft / PBFT)            │
         └─────────────┬──────────────┘
                       │
         ┌─────────────┼─────────────┐
         │             │             │
┌────────▼───┐ ┌───────▼────┐ ┌──────▼─────┐
│Dispatcher  │ │Dispatcher  │ │Dispatcher  │
│ A (Leader) │ │     B      │ │     C      │
└──────┬─────┘ └─────┬──────┘ └─────┬──────┘
       │             │              │
       │        ┌────┴────┐         │
       │        │         │         │
       └────────►Worker選定◄─────────┘
                │ (合意形成)│
                └────┬────┘
                     │
         ┌───────────┼───────────┐
         ▼           ▼           ▼
    ┌─────────┐ ┌─────────┐ ┌─────────┐
    │ Worker  │ │ Worker  │ │ Worker  │
    │   1     │ │   2     │ │   3     │
    └────┬────┘ └────┬────┘ └────┬────┘
         │           │           │
         └───────────┼───────────┘
                     │
         ┌───────────▼───────────┐
         │    結果を集約・検証     │
         │    （クォーラム合意）   │
         └───────────┬───────────┘
                     │
              ┌──────▼──────┐
              │  クライアント  │
              │   へ応答     │
              └─────────────┘
```

**特徴:**
- RaftやPBFTなどの合意形成アルゴリズムで、複数ディスパッチャーが協調
- リーダー選出でタスク割り当てを決定、フォロワーが検証
- ビザンチン障害耐性あり（最大f個の悪意あるディスパッチャーまで許容）
- 高い信頼性と整合性を保証

### 2.4 パターンD: エッジ・ディスパッチャー（軽量）

```
┌────────────────────────────────────────────────────────────┐
│                      エッジネットワーク                      │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐      │
│  │  Edge    │ │  Edge    │ │  Edge    │ │  Edge    │      │
│  │  Node 1  │ │  Node 2  │ │  Node 3  │ │  Node N  │      │
│  │ (Cloudflare│ │ (Vercel) │ │ (Deno)   │ │ (Fly.io) │      │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘      │
│       │            │            │            │             │
│       └────────────┴────────────┴────────────┘             │
│                    │                                       │
│                    ▼                                       │
│       ┌─────────────────────┐                              │
│       │  WebRTC DataChannel │                              │
│       │  ディスパッチャー間通信 │                          │
│       └─────────────────────┘                              │
└──────────────────────────┬─────────────────────────────────┘
                           │
          ┌────────────────┼────────────────┐
          │                │                │
┌─────────▼────────┐ ┌────▼─────┐ ┌────────▼─────────┐
│   Worker Pool    │ │ Worker   │ │   Worker Pool    │
│   (Tokyo)        │ │ Pool     │ │   (Sao Paulo)    │
│                  │ │ (Berlin) │ │                  │
└──────────────────┘ └──────────┘ └──────────────────┘
```

**特徴:**
- Cloudflare Workers、Vercel Edge、Deno Deployなどのエッジサーバーレスで構成
- 地理的に最も近いエッジノードがディスパッチャーとして動作
- WebRTC DataChannelでエッジ間を直接接続
- Workerプール情報はエッジ間で同期、最寄りのWorkerを優先選定

### 2.5 パターンE: フェデレーション・モデル

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│ Website A   │◄───►│ Website B   │◄───►│ Website C   │
│ (E-commerce)│     │ (News)      │     │ (SNS)       │
│             │     │             │     │             │
│ ┌─────────┐ │     │ ┌─────────┐ │     │ ┌─────────┐ │
│ │Disp. A  │ │     │ │Disp. B  │ │     │ │Disp. C  │ │
│ │+Worker池│ │     │ │+Worker池│ │     │ │+Worker池│ │
│ └────┬────┘ │     │ └────┬────┘ │     │ └────┬────┘ │
└──────┼──────┘     └──────┼──────┘     └──────┼──────┘
       │                   │                   │
       └───────────────────┼───────────────────┘
                           │
                    ┌──────▼──────┐
                    │ 相互負荷分散  │
                    │  プロトコル   │
                    └─────────────┘
```

**特徴:**
- 複数の独立したWebサイトが独自のディスパッチャーとWorkerプールを持つ
- Worker不足時に相互にタスクを委託（federation）
- 標準化されたAPIでサイト間通信
- 各サイトは自律的に運用しつつ、グローバルなリソースプールに参加

## 3. 技術的実装戦略

### 3.1 ディスパッチャー間通信プロトコル

```typescript
// ディスパッチャー間通信インターフェース
interface DispatcherProtocol {
  // Workerプール状態の同期
  syncWorkerPool(
    localWorkers: WorkerInfo[],
    timestamp: number
  ): Promise<WorkerSyncResult>;
  
  // タスク委託（他ディスパッチャーへの委託）
  delegateTask(
    task: Task,
    originDispatcher: string
  ): Promise<TaskDelegationResult>;
  
  // 結果共有（重複実行時の結果比較）
  shareResult(
    taskId: string,
    result: ExecutionResult,
    hash: string
  ): Promise<void>;
  
  // ヘルスチェック
  healthCheck(): Promise<DispatcherHealth>;
  
  // リーダー選出（Raftなど）
  requestVote(
    term: number,
    candidateId: string
  ): Promise<VoteResponse>;
  
  appendEntries(
    term: number,
    leaderId: string,
    entries: LogEntry[]
  ): Promise<AppendResult>;
}
```

### 3.2 一貫性モデル

| パターン | 一貫性レベル | 可用性 | レイテンシ | ユースケース |
|---------|------------|--------|-----------|------------|
| **マルチマスター** | 結果整合性（Eventual） | 高 | 低 | 一般的なワークロード |
| **DHTベース** | 因果一貫性 | 高 | 低 | 大規模分散 |
| **P2Pコンセンサス** | 厳密一貫性（Strong） | 中 | 高 | 金融・決済 |
| **エッジ** | 結果整合性 | 最高 | 最低 | エッジ重視 |
| **フェデレーション** | 結果整合性 | 高 | 中 | マルチテナント |

### 3.3 障害検出と復旧

```typescript
// ディスパッチャー障害検出
class DispatcherFailureDetector {
  private heartbeats = new Map<string, number>();
  private readonly SUSPECT_THRESHOLD = 3000;  // 3秒
  private readonly CONFIRM_THRESHOLD = 5000;  // 5秒
  
  onHeartbeat(dispatcherId: string): void {
    this.heartbeats.set(dispatcherId, Date.now());
  }
  
  checkHealth(): DispatcherHealth[] {
    const now = Date.now();
    const results: DispatcherHealth[] = [];
    
    for (const [id, lastHeartbeat] of this.heartbeats) {
      const elapsed = now - lastHeartbeat;
      
      if (elapsed > this.CONFIRM_THRESHOLD) {
        results.push({ id, status: 'FAILED', elapsed });
      } else if (elapsed > this.SUSPECT_THRESHOLD) {
        results.push({ id, status: 'SUSPECTED', elapsed });
      } else {
        results.push({ id, status: 'HEALTHY', elapsed });
      }
    }
    
    return results;
  }
}

// 復旧時のリバランシング
class RebalancingCoordinator {
  async onDispatcherRecovered(
    recoveredDispatcher: string
  ): Promise<void> {
    // 1. 復旧したディスパッチャーのWorkerプールを再登録
    const workers = await this.getWorkers(recoveredDispatcher);
    await this.registerWorkers(workers);
    
    // 2. タスクの段階的なリバランシング
    const tasks = await this.getRebalanceableTasks();
    const batchSize = Math.ceil(tasks.length / 10);  // 10%ずつ
    
    for (let i = 0; i < tasks.length; i += batchSize) {
      const batch = tasks.slice(i, i + batchSize);
      await this.migrateTasks(batch, recoveredDispatcher);
      await this.sleep(1000);  // 1秒待機
    }
  }
}
```

## 4. トレードオフ分析

### 4.1 分散度 vs 複雑性

```
分散度
  ▲
  │
高├───────────┬───────────┬───────────┐
  │           │           │           │
  │ P2Pコンセン│マルチマスタ │ DHTベース │ エッジ
  │ サス      │           │           │
  │           │           │           │
中├───────────┼───────────┼───────────┤
  │           │           │           │
  │           │ フェデレー │           │
  │           │ ション     │           │
  │           │           │           │
低├───────────┴───────────┴───────────┤
  │           中央集権                  │
  └───────────────────────────────────►
  低          複雑性                    高
```

### 4.2 選定ガイド

| 要件 | 推奨パターン | 理由 |
|------|------------|------|
| 高可用性（99.999%） | P2Pコンセンサス | ビザンチン耐性あり |
| 低レイテンシ（グローバル） | エッジ | 地理的に最適化 |
| 大規模スケール（100万Worker） | DHTベース | 水平スケーリング可能 |
| 複数組織連携 | フェデレーション | 自律性と協調性のバランス |
| シンプル実装 | マルチマスター | 実装容易、十分な分散性 |

## 5. 実装ロードマップ

### Phase 1: 単一ディスパッチャー（現在）
- [x] 基本機能実装
- [x] Worker管理
- [x] フォールバック機構

### Phase 2: マルチマスター（短期）
- [ ] Redis Cluster導入
- [ ] 地理分散デプロイ（3リージョン）
- [ ] Anycast DNS設定
- [ ] ステート同期実装

### Phase 3: 高度分散化（中期）
- [ ] DHTベース選定の実装
- [ ] エッジデプロイ対応
- [ ] ディスパッチャー間P2P通信
- [ ] 自動リバランシング

### Phase 4: 完全分散（長期）
- [ ] フェデレーションプロトコル
- [ ] ブロックチェーン連携（オプション）
- [ ] 自律的なディスパッチャー選出

## 6. 参考資料

- [Raft Consensus Algorithm](https://raft.github.io/)
- [Kademlia DHT Paper](https://pdos.csail.mit.edu/~petar/papers/maymounkov-kademlia-lncs.pdf)
- [PBFT Original Paper](https://pmg.csail.mit.edu/papers/osdi99.pdf)
- [Cloudflare Anycast](https://www.cloudflare.com/learning/cdn/glossary/anycast-network/)
- [Edge Computing Patterns](https://www.edge-computing-patterns.org/)

---

**ドキュメントバージョン**: 1.0  
**作成日**: 2026年2月  
**ステータス**: 設計草案
