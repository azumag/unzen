/**
 * Swarm: the main entry point for swarm-based LLM inference.
 *
 * Current implementation: centralized simulation of the swarm lifecycle.
 * Each phase (scatter/evaluate/converge) is orchestrated synchronously here.
 * In production, these phases would be driven by gossip protocol messages
 * relayed through unzen infrastructure, with no single orchestrator.
 *
 * This prototype validates the core algorithm (multi-agent sampling +
 * cross-evaluation + consensus) before investing in decentralized gossip.
 *
 * Architecture contrast with Coordinator (../coordinator.ts):
 *   - Coordinator: central brain that assigns segments and manages pipeline
 *   - Swarm: peers are autonomous; this class triggers phases and collects
 *     results, but the scoring/selection intelligence lives in the peers
 */

import {
  type PeerId,
  type TaskId,
  type SwarmConfig,
  type SwarmResult,
  type Proposal,
  type Evaluation,
  DEFAULT_SWARM_CONFIG,
  taskId,
} from './types.js';
import { SwarmPeer } from './peer.js';
import { SwarmConsensus } from './consensus.js';
import { withTimeout } from '../pipeline-utils.js';

export class Swarm {
  private readonly peers = new Map<PeerId, SwarmPeer>();
  private readonly config: SwarmConfig;
  private taskCounter = 0;

  constructor(config?: Partial<SwarmConfig>) {
    this.config = { ...DEFAULT_SWARM_CONFIG, ...config };
    this.validateConfig(this.config);
  }

  private validateConfig(c: SwarmConfig): void {
    if (c.minPeers < 2) {
      throw new SwarmError(`minPeers must be >= 2, got ${c.minPeers}`);
    }
    if (c.maxPeers < c.minPeers) {
      throw new SwarmError(
        `maxPeers (${c.maxPeers}) must be >= minPeers (${c.minPeers})`,
      );
    }
    if (c.consensusThreshold <= 0 || c.consensusThreshold > 1) {
      throw new SwarmError(
        `consensusThreshold must be in (0, 1], got ${c.consensusThreshold}`,
      );
    }
    if (c.proposalTimeoutMs <= 0) {
      throw new SwarmError(
        `proposalTimeoutMs must be > 0, got ${c.proposalTimeoutMs}`,
      );
    }
    if (c.evaluationTimeoutMs <= 0) {
      throw new SwarmError(
        `evaluationTimeoutMs must be > 0, got ${c.evaluationTimeoutMs}`,
      );
    }
  }

  addPeer(peer: SwarmPeer): void {
    // Remove existing peer with same ID first to avoid inconsistent state
    if (this.peers.has(peer.info.id)) {
      this.removePeer(peer.info.id);
    }
    this.peers.set(peer.info.id, peer);
    for (const existing of this.peers.values()) {
      if (existing.info.id !== peer.info.id) {
        existing.addKnownPeer(peer.info.id);
        peer.addKnownPeer(existing.info.id);
      }
    }
  }

  removePeer(id: PeerId): void {
    this.peers.delete(id);
    for (const peer of this.peers.values()) {
      peer.removeKnownPeer(id);
    }
  }

  get peerCount(): number {
    return this.peers.size;
  }

  /**
   * Submit an inference task to the swarm.
   *
   * Phase 1 (Scatter): Select up to maxPeers participants, each generates
   *   a proposal independently with timeout enforcement.
   *
   * Phase 2 (Evaluate): Each peer scores all proposals (excluding own).
   *   Cross-evaluation leverages the insight that even weak models can
   *   discriminate quality better than they can produce it.
   *
   * Phase 3 (Converge): Aggregate scores and select the winning proposal.
   *   If no clear consensus, the top-scored proposal is returned (best-effort).
   */
  async submitTask(prompt: string): Promise<SwarmResult> {
    if (this.peers.size < this.config.minPeers) {
      throw new SwarmError(
        `Not enough peers: have ${this.peers.size}, need ${this.config.minPeers}`,
      );
    }

    this.taskCounter++;
    const tId = taskId(`swarm-task-${this.taskCounter}`);
    const startTime = Date.now();

    const participants = this.selectParticipants();

    // Phase 1: Scatter — parallel proposal generation with timeout
    const proposals = await this.gatherProposals(tId, prompt, participants);

    // Cross-evaluation requires at least 2 proposals to be meaningful.
    // With only 1 proposal there is nothing to compare against.
    if (proposals.length < 2) {
      throw new SwarmError(
        `Not enough proposals: got ${proposals.length}, need at least 2 for cross-evaluation`,
      );
    }

    // Phase 2: Evaluate — cross-evaluation with timeout
    const evaluations = await this.crossEvaluate(
      prompt,
      proposals,
      participants,
    );

    // Phase 3: Converge — consensus
    const consensus = new SwarmConsensus(this.config.consensusThreshold);
    const scores = consensus.aggregateScores(evaluations);
    const winner = consensus.selectWinner(proposals, scores);

    if (!winner) {
      throw new SwarmError('Failed to reach consensus: no scored proposals');
    }

    return {
      taskId: tId,
      text: winner.proposal.text,
      participantCount: participants.length,
      proposalCount: proposals.length,
      consensusScore: winner.score,
      consensusReached: consensus.hasConsensus(scores),
      totalTimeMs: Date.now() - startTime,
    };
  }

  private selectParticipants(): SwarmPeer[] {
    const all = [...this.peers.values()];
    if (all.length <= this.config.maxPeers) return all;

    // Fisher-Yates shuffle, take maxPeers
    for (let i = all.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [all[i], all[j]] = [all[j], all[i]];
    }
    return all.slice(0, this.config.maxPeers);
  }

  /**
   * Phase 1: Each participant generates a proposal in parallel.
   * Each generation is raced against proposalTimeoutMs.
   * Timeouts and failures are silently dropped.
   */
  private async gatherProposals(
    tId: TaskId,
    prompt: string,
    participants: SwarmPeer[],
  ): Promise<Proposal[]> {
    const results = await Promise.allSettled(
      participants.map((peer) =>
        withTimeout(
          peer.generateProposal(tId, prompt),
          this.config.proposalTimeoutMs,
          `Proposal from ${peer.info.id}`,
        ),
      ),
    );

    return results
      .filter(
        (r): r is PromiseFulfilledResult<Proposal> =>
          r.status === 'fulfilled',
      )
      .map((r) => r.value);
  }

  /**
   * Phase 2: Each participant evaluates every proposal except its own.
   * Each evaluation is raced against evaluationTimeoutMs.
   * Failures are silently dropped.
   */
  private async crossEvaluate(
    prompt: string,
    proposals: readonly Proposal[],
    participants: SwarmPeer[],
  ): Promise<Evaluation[]> {
    const evalPromises: Promise<Evaluation>[] = [];

    for (const peer of participants) {
      for (const proposal of proposals) {
        if (proposal.peerId === peer.info.id) continue;
        evalPromises.push(
          withTimeout(
            peer.evaluateProposal(prompt, proposal),
            this.config.evaluationTimeoutMs,
            `Evaluation by ${peer.info.id}`,
          ),
        );
      }
    }

    const results = await Promise.allSettled(evalPromises);

    return results
      .filter(
        (r): r is PromiseFulfilledResult<Evaluation> =>
          r.status === 'fulfilled',
      )
      .map((r) => r.value);
  }
}

export class SwarmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SwarmError';
  }
}
