import { describe, it, expect, beforeEach } from 'vitest';
import { GossipProtocol } from '../../src/swarm/gossip.js';
import {
  peerId,
  taskId,
  proposalId,
  type Proposal,
  type Evaluation,
} from '../../src/swarm/types.js';

let proposalCounter = 0;

function makeProposal(pId: string, tId: string, text: string): Proposal {
  proposalCounter++;
  return {
    id: proposalId(`${pId}-p${proposalCounter}`),
    taskId: taskId(tId),
    peerId: peerId(pId),
    text,
    generationTimeMs: 100,
  };
}

function makeEvaluation(
  evaluator: string,
  pId: string,
  tId: string,
  score: number,
): Evaluation {
  return {
    taskId: taskId(tId),
    evaluatorId: peerId(evaluator),
    proposalId: proposalId(`${pId}-p1`),
    score,
  };
}

describe('GossipProtocol', () => {
  let gossip: GossipProtocol;

  beforeEach(() => {
    proposalCounter = 0;
    gossip = new GossipProtocol();
  });

  describe('proposal management', () => {
    it('should store and retrieve proposals', () => {
      const p = makeProposal('peer-1', 'task-1', 'answer');
      gossip.addProposal(p);

      const proposals = gossip.getProposals(taskId('task-1'));
      expect(proposals).toHaveLength(1);
      expect(proposals[0].text).toBe('answer');
    });

    it('should return empty array for unknown tasks', () => {
      expect(gossip.getProposals(taskId('unknown'))).toEqual([]);
    });

    it('should store multiple proposals for the same task', () => {
      gossip.addProposal(makeProposal('p1', 'task-1', 'answer 1'));
      gossip.addProposal(makeProposal('p2', 'task-1', 'answer 2'));

      expect(gossip.getProposals(taskId('task-1'))).toHaveLength(2);
    });

    it('should not duplicate proposals with the same id', () => {
      const p = makeProposal('p1', 'task-1', 'answer');
      gossip.addProposal(p);
      gossip.addProposal(p);

      expect(gossip.getProposals(taskId('task-1'))).toHaveLength(1);
    });
  });

  describe('evaluation management', () => {
    it('should store and retrieve evaluations', () => {
      const e = makeEvaluation('eval-1', 'p1', 'task-1', 0.8);
      gossip.addEvaluation(e);

      const evals = gossip.getEvaluations(taskId('task-1'));
      expect(evals).toHaveLength(1);
      expect(evals[0].score).toBe(0.8);
    });

    it('should store evaluations from multiple evaluators', () => {
      gossip.addEvaluation(makeEvaluation('eval-1', 'p1', 'task-1', 0.8));
      gossip.addEvaluation(makeEvaluation('eval-2', 'p1', 'task-1', 0.6));

      expect(gossip.getEvaluations(taskId('task-1'))).toHaveLength(2);
    });

    it('should not store duplicate evaluations (same evaluator, same proposal)', () => {
      gossip.addEvaluation(makeEvaluation('eval-1', 'p1', 'task-1', 0.8));
      gossip.addEvaluation(makeEvaluation('eval-1', 'p1', 'task-1', 0.9));

      const evals = gossip.getEvaluations(taskId('task-1'));
      expect(evals).toHaveLength(1);
      // First evaluation wins (idempotent)
      expect(evals[0].score).toBe(0.8);
    });
  });

  describe('getNewProposals', () => {
    it('should return proposals not yet seen by a peer', () => {
      const prop1 = makeProposal('p1', 'task-1', 'a1');
      const prop2 = makeProposal('p2', 'task-1', 'a2');
      gossip.addProposal(prop1);
      gossip.addProposal(prop2);

      // Mark p1's proposal as seen
      gossip.markProposalSeen(peerId('target'), prop1.id);

      const newOnes = gossip.getNewProposals(
        taskId('task-1'),
        peerId('target'),
      );
      expect(newOnes).toHaveLength(1);
      expect(newOnes[0].peerId).toBe(peerId('p2'));
    });

    it('should return all proposals if none seen', () => {
      gossip.addProposal(makeProposal('p1', 'task-1', 'a1'));
      gossip.addProposal(makeProposal('p2', 'task-1', 'a2'));

      const newOnes = gossip.getNewProposals(
        taskId('task-1'),
        peerId('target'),
      );
      expect(newOnes).toHaveLength(2);
    });
  });

  describe('getNewEvaluations', () => {
    it('should return evaluations not yet seen by a peer', () => {
      const eval1 = makeEvaluation('e1', 'p1', 'task-1', 0.8);
      const eval2 = makeEvaluation('e2', 'p1', 'task-1', 0.6);
      gossip.addEvaluation(eval1);
      gossip.addEvaluation(eval2);

      // Mark e1's evaluation as seen by target
      const evalKey = `${eval1.evaluatorId}:${eval1.proposalId}`;
      gossip.markEvaluationSeen(peerId('target'), evalKey);

      const newOnes = gossip.getNewEvaluations(
        taskId('task-1'),
        peerId('target'),
      );
      expect(newOnes).toHaveLength(1);
      expect(newOnes[0].evaluatorId).toBe(peerId('e2'));
    });
  });

  describe('cleanup', () => {
    it('should remove all data for a completed task', () => {
      gossip.addProposal(makeProposal('p1', 'task-1', 'a'));
      gossip.addEvaluation(makeEvaluation('e1', 'p1', 'task-1', 0.8));

      gossip.cleanupTask(taskId('task-1'));

      expect(gossip.getProposals(taskId('task-1'))).toEqual([]);
      expect(gossip.getEvaluations(taskId('task-1'))).toEqual([]);
    });
  });
});
