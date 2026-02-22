/**
 * SwarmConsensus: algorithms for reaching agreement without a central authority.
 *
 * Inspired by biological swarm decision-making:
 *   - Honeybee nest-site selection: scouts evaluate options independently,
 *     then "vote" via waggle dances. The site with the most enthusiastic
 *     support wins (quorum sensing).
 *   - Ant colony optimization: individual ants score paths by depositing
 *     pheromones; the best path emerges from accumulated signals.
 *
 * Applied to LLM inference:
 *   1. Each peer generates a proposal (scout phase)
 *   2. Each peer scores all proposals it sees (evaluation phase)
 *   3. Scores are aggregated across peers (pheromone accumulation)
 *   4. The proposal with the highest aggregate wins (quorum sensing)
 *
 * Two aggregation modes:
 *   - Uniform: simple average of all evaluations (aggregateScores)
 *   - Weighted: evaluations weighted by peer reliability (aggregateScoresWeighted)
 *     More reliable peers have stronger "pheromone" — their votes count more.
 *
 * Consensus detection:
 *   Consensus is reached when a clear winner emerges:
 *   - The top proposal's score exceeds the configured threshold
 *   - AND the gap between top and second is >= 0.1 (clear separation)
 *   This prevents premature convergence on mediocre proposals when
 *   scores are clustered.
 */

import type {
  ProposalId,
  Proposal,
  Evaluation,
  PeerId,
  PeerInfo,
} from './types.js';

export interface ConsensusWinner {
  readonly proposal: Proposal;
  readonly score: number;
}

export class SwarmConsensus {
  /**
   * @param threshold - Minimum score for consensus (0-1).
   * @param minGap - Minimum score gap between top-2 proposals
   *   for consensus. 0.1 by default. Prevents declaring consensus
   *   when multiple proposals are rated similarly.
   */
  constructor(
    private readonly threshold: number,
    private readonly minGap: number = 0.1,
  ) {}

  /**
   * Compute the average score for each proposal (uniform weighting).
   * Returns a Map from proposalId to aggregate score.
   */
  aggregateScores(evaluations: readonly Evaluation[]): Map<ProposalId, number> {
    const sums = new Map<ProposalId, { total: number; count: number }>();

    for (const e of evaluations) {
      const entry = sums.get(e.proposalId) ?? { total: 0, count: 0 };
      entry.total += e.score;
      entry.count += 1;
      sums.set(e.proposalId, entry);
    }

    const result = new Map<ProposalId, number>();
    for (const [id, { total, count }] of sums) {
      result.set(id, total / count);
    }
    return result;
  }

  /**
   * Compute weighted average scores using peer reliability as weights.
   * More reliable peers (higher historical score) have greater influence
   * on the consensus, similar to stronger pheromone trails in ACO.
   *
   * Unknown peers default to reliability=1.0 (benefit of the doubt).
   */
  aggregateScoresWeighted(
    evaluations: readonly Evaluation[],
    peerInfos: ReadonlyMap<PeerId, PeerInfo>,
  ): Map<ProposalId, number> {
    const sums = new Map<
      ProposalId,
      { weightedTotal: number; weightSum: number }
    >();

    for (const e of evaluations) {
      const reliability = peerInfos.get(e.evaluatorId)?.reliability ?? 1.0;
      const entry = sums.get(e.proposalId) ?? {
        weightedTotal: 0,
        weightSum: 0,
      };
      entry.weightedTotal += e.score * reliability;
      entry.weightSum += reliability;
      sums.set(e.proposalId, entry);
    }

    const result = new Map<ProposalId, number>();
    for (const [id, { weightedTotal, weightSum }] of sums) {
      result.set(id, weightSum > 0 ? weightedTotal / weightSum : 0);
    }
    return result;
  }

  /**
   * Select the proposal with the highest aggregate score.
   * Returns null if no proposals or no scores are available.
   */
  selectWinner(
    proposals: readonly Proposal[],
    scores: ReadonlyMap<ProposalId, number>,
  ): ConsensusWinner | null {
    if (proposals.length === 0 || scores.size === 0) return null;

    let best: ConsensusWinner | null = null;

    for (const p of proposals) {
      const score = scores.get(p.id);
      if (score === undefined) continue;
      if (!best || score > best.score) {
        best = { proposal: p, score };
      }
    }

    return best;
  }

  /**
   * Check whether the scores indicate clear consensus.
   * Consensus requires:
   *   1. At least one proposal scored
   *   2. The top score meets or exceeds the threshold
   *   3. If multiple proposals: the gap between #1 and #2 >= minGap
   */
  hasConsensus(scores: ReadonlyMap<ProposalId, number>): boolean {
    if (scores.size === 0) return false;

    const sorted = [...scores.values()].sort((a, b) => b - a);
    const top = sorted[0];

    if (top < this.threshold) return false;

    // Single proposal: threshold alone is sufficient
    if (sorted.length === 1) return true;

    // Multiple proposals: require clear separation
    return top - sorted[1] >= this.minGap;
  }
}
