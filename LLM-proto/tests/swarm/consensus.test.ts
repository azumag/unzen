import { describe, it, expect } from 'vitest';
import { SwarmConsensus } from '../../src/swarm/consensus.js';
import {
  peerId,
  taskId,
  proposalId,
  type Proposal,
  type Evaluation,
  type PeerInfo,
  PeerStatus,
} from '../../src/swarm/types.js';

function makeProposal(peerName: string, text: string): Proposal {
  return {
    id: proposalId(`${peerName}-p1`),
    taskId: taskId('task-1'),
    peerId: peerId(peerName),
    text,
    generationTimeMs: 100,
  };
}

function makeEval(
  evaluator: string,
  proposalPeer: string,
  score: number,
): Evaluation {
  return {
    taskId: taskId('task-1'),
    evaluatorId: peerId(evaluator),
    proposalId: proposalId(`${proposalPeer}-p1`),
    score,
  };
}

function makePeerInfo(name: string, reliability = 1.0): PeerInfo {
  return {
    id: peerId(name),
    status: PeerStatus.IDLE,
    lastSeen: Date.now(),
    reliability,
  };
}

describe('SwarmConsensus', () => {
  let consensus: SwarmConsensus;

  describe('aggregateScores', () => {
    it('should compute average score per proposal', () => {
      consensus = new SwarmConsensus(0.6);
      const evaluations = [
        makeEval('e1', 'p1', 0.8),
        makeEval('e2', 'p1', 0.6),
        makeEval('e1', 'p2', 0.3),
        makeEval('e2', 'p2', 0.5),
      ];

      const scores = consensus.aggregateScores(evaluations);

      // p1 avg: (0.8 + 0.6) / 2 = 0.7
      expect(scores.get(proposalId('p1-p1'))).toBeCloseTo(0.7, 5);
      // p2 avg: (0.3 + 0.5) / 2 = 0.4
      expect(scores.get(proposalId('p2-p1'))).toBeCloseTo(0.4, 5);
    });

    it('should handle single evaluation', () => {
      consensus = new SwarmConsensus(0.6);
      const evaluations = [makeEval('e1', 'p1', 0.9)];

      const scores = consensus.aggregateScores(evaluations);
      expect(scores.get(proposalId('p1-p1'))).toBeCloseTo(0.9, 5);
    });

    it('should return empty map for no evaluations', () => {
      consensus = new SwarmConsensus(0.6);
      const scores = consensus.aggregateScores([]);
      expect(scores.size).toBe(0);
    });
  });

  describe('aggregateScoresWeighted', () => {
    it('should weight scores by peer reliability', () => {
      consensus = new SwarmConsensus(0.6);

      const evaluations = [
        makeEval('reliable', 'p1', 0.8),
        makeEval('unreliable', 'p1', 0.2),
      ];

      const peerInfos = new Map([
        [peerId('reliable'), makePeerInfo('reliable', 1.0)],
        [peerId('unreliable'), makePeerInfo('unreliable', 0.5)],
      ]);

      const scores = consensus.aggregateScoresWeighted(evaluations, peerInfos);

      // Weighted avg: (0.8*1.0 + 0.2*0.5) / (1.0 + 0.5) = 0.9 / 1.5 = 0.6
      expect(scores.get(proposalId('p1-p1'))).toBeCloseTo(0.6, 5);
    });

    it('should fall back to uniform weights for unknown peers', () => {
      consensus = new SwarmConsensus(0.6);

      const evaluations = [
        makeEval('known', 'p1', 0.8),
        makeEval('unknown', 'p1', 0.4),
      ];

      // Only "known" peer has info; "unknown" defaults to reliability=1.0
      const peerInfos = new Map([
        [peerId('known'), makePeerInfo('known', 1.0)],
      ]);

      const scores = consensus.aggregateScoresWeighted(evaluations, peerInfos);
      // Both weight=1.0: (0.8 + 0.4) / 2 = 0.6
      expect(scores.get(proposalId('p1-p1'))).toBeCloseTo(0.6, 5);
    });
  });

  describe('selectWinner', () => {
    it('should select the proposal with the highest aggregate score', () => {
      consensus = new SwarmConsensus(0.6);

      const proposals = [
        makeProposal('p1', 'good answer'),
        makeProposal('p2', 'bad answer'),
      ];

      const scores = new Map([
        [proposalId('p1-p1'), 0.9],
        [proposalId('p2-p1'), 0.3],
      ]);

      const winner = consensus.selectWinner(proposals, scores);
      expect(winner).not.toBeNull();
      expect(winner!.proposal.text).toBe('good answer');
      expect(winner!.score).toBeCloseTo(0.9, 5);
    });

    it('should return null if no proposals', () => {
      consensus = new SwarmConsensus(0.6);
      const winner = consensus.selectWinner([], new Map());
      expect(winner).toBeNull();
    });

    it('should return null if no scores available', () => {
      consensus = new SwarmConsensus(0.6);
      const proposals = [makeProposal('p1', 'answer')];
      const winner = consensus.selectWinner(proposals, new Map());
      expect(winner).toBeNull();
    });
  });

  describe('hasConsensus', () => {
    it('should return true when top score exceeds threshold', () => {
      consensus = new SwarmConsensus(0.6);

      const scores = new Map([
        [proposalId('p1-p1'), 0.85],
        [proposalId('p2-p1'), 0.3],
      ]);

      // With threshold 0.6, the top score (0.85) relative to the field
      // should indicate consensus. We define consensus as:
      // top score >= threshold AND the gap between top and second >= 0.1
      expect(consensus.hasConsensus(scores)).toBe(true);
    });

    it('should return false when scores are too close', () => {
      consensus = new SwarmConsensus(0.6);

      const scores = new Map([
        [proposalId('p1-p1'), 0.72],
        [proposalId('p2-p1'), 0.7],
      ]);

      // Gap is only 0.02 — no clear winner
      expect(consensus.hasConsensus(scores)).toBe(false);
    });

    it('should return false when top score is below threshold', () => {
      consensus = new SwarmConsensus(0.6);

      const scores = new Map([
        [proposalId('p1-p1'), 0.4],
        [proposalId('p2-p1'), 0.2],
      ]);

      expect(consensus.hasConsensus(scores)).toBe(false);
    });

    it('should return true for a single proposal above threshold', () => {
      consensus = new SwarmConsensus(0.6);
      const scores = new Map([[proposalId('p1-p1'), 0.8]]);
      expect(consensus.hasConsensus(scores)).toBe(true);
    });

    it('should return false for empty scores', () => {
      consensus = new SwarmConsensus(0.6);
      expect(consensus.hasConsensus(new Map())).toBe(false);
    });
  });
});
