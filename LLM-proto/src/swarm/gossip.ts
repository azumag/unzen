/**
 * GossipProtocol: decentralized state propagation for swarm peers.
 *
 * In biological swarms, individuals share information through local
 * interactions (e.g., ant pheromone trails). This module implements
 * the digital equivalent: peers exchange proposals and evaluations
 * with a subset of known peers each round, and information spreads
 * exponentially through the network.
 *
 * Key properties:
 *   - No global state: each peer maintains its own partial view
 *   - Convergence: O(log N) rounds for information to reach all N peers
 *   - Idempotent: duplicate messages are safely ignored
 *   - Peer-tracked delivery: each peer tracks what each neighbor has seen,
 *     so gossip rounds only transmit new information (delta propagation)
 *
 * This class manages the local state (proposals, evaluations, seen-tracking)
 * for one peer. The actual network transport is handled externally.
 */

import type {
  PeerId,
  TaskId,
  ProposalId,
  Proposal,
  Evaluation,
} from './types.js';

export class GossipProtocol {
  /**
   * Proposals indexed by taskId.
   * Inner map: proposalId → Proposal (prevents duplicates).
   */
  private readonly proposals = new Map<TaskId, Map<ProposalId, Proposal>>();

  /**
   * Evaluations indexed by taskId.
   * Inner map: "evaluatorId:proposalId" → Evaluation (prevents duplicate scoring).
   */
  private readonly evaluations = new Map<TaskId, Map<string, Evaluation>>();

  /**
   * Tracks which proposals each peer has already seen.
   * Outer key: peerId. Inner set: proposalIds.
   * Used by getNewProposals() to compute deltas for gossip.
   */
  private readonly seenProposals = new Map<PeerId, Set<ProposalId>>();

  /**
   * Tracks which evaluations each peer has already seen.
   * Outer key: peerId. Inner set: "evaluatorId:proposalId" keys.
   */
  private readonly seenEvaluations = new Map<PeerId, Set<string>>();

  constructor() {}

  // --- Proposal management ---

  addProposal(proposal: Proposal): void {
    let taskProposals = this.proposals.get(proposal.taskId);
    if (!taskProposals) {
      taskProposals = new Map();
      this.proposals.set(proposal.taskId, taskProposals);
    }
    // Idempotent: first write wins
    if (!taskProposals.has(proposal.id)) {
      taskProposals.set(proposal.id, proposal);
    }
  }

  getProposals(taskId: TaskId): Proposal[] {
    const taskProposals = this.proposals.get(taskId);
    return taskProposals ? [...taskProposals.values()] : [];
  }

  // --- Evaluation management ---

  addEvaluation(evaluation: Evaluation): void {
    let taskEvals = this.evaluations.get(evaluation.taskId);
    if (!taskEvals) {
      taskEvals = new Map();
      this.evaluations.set(evaluation.taskId, taskEvals);
    }
    const key = `${evaluation.evaluatorId}:${evaluation.proposalId}`;
    // Idempotent: first write wins
    if (!taskEvals.has(key)) {
      taskEvals.set(key, evaluation);
    }
  }

  getEvaluations(taskId: TaskId): Evaluation[] {
    const taskEvals = this.evaluations.get(taskId);
    return taskEvals ? [...taskEvals.values()] : [];
  }

  // --- Delta tracking for gossip ---

  markProposalSeen(peerId: PeerId, proposalId: ProposalId): void {
    let seen = this.seenProposals.get(peerId);
    if (!seen) {
      seen = new Set();
      this.seenProposals.set(peerId, seen);
    }
    seen.add(proposalId);
  }

  markEvaluationSeen(peerId: PeerId, evalKey: string): void {
    let seen = this.seenEvaluations.get(peerId);
    if (!seen) {
      seen = new Set();
      this.seenEvaluations.set(peerId, seen);
    }
    seen.add(evalKey);
  }

  /** Get proposals for a task that a specific peer hasn't seen yet. */
  getNewProposals(taskId: TaskId, targetPeerId: PeerId): Proposal[] {
    const all = this.getProposals(taskId);
    const seen = this.seenProposals.get(targetPeerId);
    if (!seen) return all;
    return all.filter((p) => !seen.has(p.id));
  }

  /** Get evaluations for a task that a specific peer hasn't seen yet. */
  getNewEvaluations(taskId: TaskId, targetPeerId: PeerId): Evaluation[] {
    const all = this.getEvaluations(taskId);
    const seen = this.seenEvaluations.get(targetPeerId);
    if (!seen) return all;
    return all.filter((e) => {
      const key = `${e.evaluatorId}:${e.proposalId}`;
      return !seen.has(key);
    });
  }

  // --- Cleanup ---

  /** Remove all data associated with a completed task. */
  cleanupTask(taskId: TaskId): void {
    this.proposals.delete(taskId);
    this.evaluations.delete(taskId);
    // Seen-tracking is not keyed by task, so clear everything to prevent
    // unbounded growth. This is acceptable because tasks are short-lived
    // and stale seen-entries for past tasks have no effect on correctness.
    this.seenProposals.clear();
    this.seenEvaluations.clear();
  }
}
