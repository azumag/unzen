/**
 * SwarmPeer: an autonomous agent in the swarm LLM network.
 *
 * Each peer runs a complete 1.2B model and participates in swarm inference:
 *   1. Generate: independently produce a candidate response for a prompt
 *   2. Evaluate: score other peers' proposals using the same model
 *   3. Gossip: exchange proposals/evaluations with random peers
 *
 * The peer is self-contained — it makes local decisions without asking
 * a central coordinator. The Evaluator interface abstracts the actual
 * LLM execution (WebGPU in production, mocked in tests).
 *
 * Design note on "why cross-evaluation works with weak models":
 *   Research (e.g., "Judging LLM-as-a-Judge", Zheng et al. 2023) shows
 *   that even small models can discriminate quality among candidates
 *   better than they can generate top-quality text from scratch.
 *   The score() function leverages this asymmetry.
 */

import {
  type PeerId,
  type TaskId,
  type ProposalId,
  type Proposal,
  type Evaluation,
  type PeerInfo,
  PeerStatus,
  proposalId,
} from './types.js';

/**
 * Abstracts LLM execution on this peer's device.
 * In production: WebGPU inference of a 1.2B model in the browser.
 * In tests: mock that returns deterministic results.
 */
export interface Evaluator {
  /** Generate a text response for the given prompt. */
  generate(prompt: string): Promise<string>;
  /** Score a candidate response (0-1) for the given prompt. */
  score(prompt: string, candidate: string): Promise<number>;
}

export class SwarmPeer {
  private readonly _info: PeerInfo;
  private readonly knownPeers = new Set<PeerId>();
  private proposalCounter = 0;

  constructor(
    id: PeerId,
    private readonly evaluator: Evaluator,
  ) {
    this._info = {
      id,
      status: PeerStatus.IDLE,
      lastSeen: Date.now(),
      reliability: 1.0,
    };
  }

  get info(): Readonly<PeerInfo> {
    return this._info;
  }

  /**
   * Generate a proposal for the given task.
   * Status transitions: IDLE → GENERATING → IDLE (or IDLE on error).
   */
  async generateProposal(taskId: TaskId, prompt: string): Promise<Proposal> {
    this._info.status = PeerStatus.GENERATING;
    const start = Date.now();
    try {
      const text = await this.evaluator.generate(prompt);
      this.proposalCounter++;
      const proposal: Proposal = {
        id: proposalId(`${this._info.id}-p${this.proposalCounter}`),
        taskId,
        peerId: this._info.id,
        text,
        generationTimeMs: Date.now() - start,
      };
      return proposal;
    } finally {
      this._info.status = PeerStatus.IDLE;
    }
  }

  /**
   * Evaluate another peer's proposal.
   * Returns a score clamped to [0, 1].
   * Status transitions: IDLE → EVALUATING → IDLE.
   */
  async evaluateProposal(
    prompt: string,
    proposal: Proposal,
  ): Promise<Evaluation> {
    // Defense in depth: self-evaluation is also blocked in swarm.ts,
    // but guard here too for direct callers or future gossip flows.
    if (proposal.peerId === this._info.id) {
      throw new Error('Self-evaluation is not allowed');
    }
    this._info.status = PeerStatus.EVALUATING;
    try {
      const rawScore = await this.evaluator.score(prompt, proposal.text);
      // Guard against NaN/Infinity from misbehaving evaluators, then clamp to [0, 1]
      const score = Number.isFinite(rawScore)
        ? Math.max(0, Math.min(1, rawScore))
        : 0;
      return {
        taskId: proposal.taskId,
        evaluatorId: this._info.id,
        proposalId: proposal.id,
        score,
      };
    } finally {
      this._info.status = PeerStatus.IDLE;
    }
  }

  // --- Peer discovery (gossip protocol support) ---

  get knownPeerIds(): PeerId[] {
    return [...this.knownPeers];
  }

  addKnownPeer(id: PeerId): void {
    if (id !== this._info.id) {
      this.knownPeers.add(id);
    }
  }

  removeKnownPeer(id: PeerId): void {
    this.knownPeers.delete(id);
  }

  /**
   * Select random peers for gossip (Fisher-Yates partial shuffle).
   * Returns min(fanout, knownPeers.size) unique peer IDs.
   */
  selectGossipTargets(fanout: number): PeerId[] {
    const all = [...this.knownPeers];
    const count = Math.min(fanout, all.length);
    // Fisher-Yates partial shuffle: only shuffle the first `count` elements
    for (let i = 0; i < count; i++) {
      const j = i + Math.floor(Math.random() * (all.length - i));
      [all[i], all[j]] = [all[j], all[i]];
    }
    return all.slice(0, count);
  }
}
