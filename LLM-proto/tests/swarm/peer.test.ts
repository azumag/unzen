import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SwarmPeer, type Evaluator } from '../../src/swarm/peer.js';
import {
  peerId,
  taskId,
  proposalId,
  PeerStatus,
  type Proposal,
} from '../../src/swarm/types.js';

/**
 * Mock evaluator that simulates a 1.2B LLM.
 * generate() returns deterministic text based on input.
 * score() returns a deterministic score based on text length (longer = better, capped at 1).
 */
function mockEvaluator(generateFn?: (prompt: string) => string): Evaluator {
  return {
    generate: vi.fn(async (prompt: string) => {
      return generateFn ? generateFn(prompt) : `response to: ${prompt}`;
    }),
    score: vi.fn(async (_prompt: string, candidate: string) => {
      // Simple heuristic: longer responses score higher (capped at 1.0)
      return Math.min(candidate.length / 100, 1.0);
    }),
  };
}

describe('SwarmPeer', () => {
  let peer: SwarmPeer;
  let evaluator: Evaluator;

  beforeEach(() => {
    evaluator = mockEvaluator();
    peer = new SwarmPeer(peerId('peer-1'), evaluator);
  });

  describe('initialization', () => {
    it('should create a peer with IDLE status', () => {
      const info = peer.info;
      expect(info.id).toBe(peerId('peer-1'));
      expect(info.status).toBe(PeerStatus.IDLE);
      expect(info.reliability).toBe(1.0);
    });
  });

  describe('generateProposal', () => {
    it('should generate a proposal for a given task', async () => {
      const tId = taskId('task-1');
      const proposal = await peer.generateProposal(tId, 'What is 2+2?');

      expect(proposal.taskId).toBe(tId);
      expect(proposal.peerId).toBe(peerId('peer-1'));
      expect(proposal.text).toBe('response to: What is 2+2?');
      expect(proposal.generationTimeMs).toBeGreaterThanOrEqual(0);
      expect(proposal.id).toBeTruthy();
    });

    it('should set status to GENERATING during generation', async () => {
      // Use a slow evaluator to observe status transition
      let resolveGenerate: ((value: string) => void) | undefined;
      const slowEvaluator: Evaluator = {
        generate: vi.fn(
          () =>
            new Promise<string>((resolve) => {
              resolveGenerate = resolve;
            }),
        ),
        score: vi.fn(async () => 0.5),
      };
      const slowPeer = new SwarmPeer(peerId('slow'), slowEvaluator);

      const promise = slowPeer.generateProposal(taskId('t'), 'prompt');
      expect(slowPeer.info.status).toBe(PeerStatus.GENERATING);

      resolveGenerate!('done');
      await promise;
      expect(slowPeer.info.status).toBe(PeerStatus.IDLE);
    });

    it('should restore IDLE status on generation failure', async () => {
      const failEvaluator: Evaluator = {
        generate: vi.fn(async () => {
          throw new Error('GPU OOM');
        }),
        score: vi.fn(async () => 0),
      };
      const failPeer = new SwarmPeer(peerId('fail'), failEvaluator);

      await expect(
        failPeer.generateProposal(taskId('t'), 'prompt'),
      ).rejects.toThrow('GPU OOM');
      expect(failPeer.info.status).toBe(PeerStatus.IDLE);
    });
  });

  describe('evaluateProposal', () => {
    it('should return a score between 0 and 1', async () => {
      const proposal: Proposal = {
        id: proposalId('p-1'),
        taskId: taskId('task-1'),
        peerId: peerId('peer-2'),
        text: 'Four. 2+2 equals 4.',
        generationTimeMs: 100,
      };

      const evaluation = await peer.evaluateProposal('What is 2+2?', proposal);
      expect(evaluation.evaluatorId).toBe(peerId('peer-1'));
      expect(evaluation.proposalId).toBe(proposalId('p-1'));
      expect(evaluation.score).toBeGreaterThanOrEqual(0);
      expect(evaluation.score).toBeLessThanOrEqual(1);
    });

    it('should reject self-evaluation', async () => {
      const selfProposal: Proposal = {
        id: proposalId('self-p'),
        taskId: taskId('t'),
        peerId: peerId('peer-1'), // same as the evaluating peer
        text: 'my own answer',
        generationTimeMs: 0,
      };

      await expect(
        peer.evaluateProposal('prompt', selfProposal),
      ).rejects.toThrow('Self-evaluation is not allowed');
    });

    it('should set status to EVALUATING during evaluation', async () => {
      let resolveScore: ((value: number) => void) | undefined;
      const slowEvaluator: Evaluator = {
        generate: vi.fn(async () => ''),
        score: vi.fn(
          () =>
            new Promise<number>((resolve) => {
              resolveScore = resolve;
            }),
        ),
      };
      const slowPeer = new SwarmPeer(peerId('slow'), slowEvaluator);
      const proposal: Proposal = {
        id: proposalId('p-1'),
        taskId: taskId('t'),
        peerId: peerId('other'),
        text: 'test',
        generationTimeMs: 0,
      };

      const promise = slowPeer.evaluateProposal('prompt', proposal);
      expect(slowPeer.info.status).toBe(PeerStatus.EVALUATING);

      resolveScore!(0.8);
      await promise;
      expect(slowPeer.info.status).toBe(PeerStatus.IDLE);
    });

    it('should clamp scores to [0, 1] range', async () => {
      // Evaluator returns out-of-range score
      const badEvaluator: Evaluator = {
        generate: vi.fn(async () => ''),
        score: vi.fn(async () => 1.5),
      };
      const badPeer = new SwarmPeer(peerId('bad'), badEvaluator);
      const proposal: Proposal = {
        id: proposalId('p-1'),
        taskId: taskId('t'),
        peerId: peerId('other'),
        text: 'test',
        generationTimeMs: 0,
      };

      const evaluation = await badPeer.evaluateProposal('prompt', proposal);
      expect(evaluation.score).toBe(1.0);
    });

    it('should treat NaN scores as 0', async () => {
      const nanEvaluator: Evaluator = {
        generate: vi.fn(async () => ''),
        score: vi.fn(async () => NaN),
      };
      const nanPeer = new SwarmPeer(peerId('nan'), nanEvaluator);
      const proposal: Proposal = {
        id: proposalId('p-1'),
        taskId: taskId('t'),
        peerId: peerId('other'),
        text: 'test',
        generationTimeMs: 0,
      };

      const evaluation = await nanPeer.evaluateProposal('prompt', proposal);
      expect(evaluation.score).toBe(0);
    });

    it('should treat Infinity scores as 0', async () => {
      const infEvaluator: Evaluator = {
        generate: vi.fn(async () => ''),
        score: vi.fn(async () => Infinity),
      };
      const infPeer = new SwarmPeer(peerId('inf'), infEvaluator);
      const proposal: Proposal = {
        id: proposalId('p-1'),
        taskId: taskId('t'),
        peerId: peerId('other'),
        text: 'test',
        generationTimeMs: 0,
      };

      const evaluation = await infPeer.evaluateProposal('prompt', proposal);
      expect(evaluation.score).toBe(0);
    });

    it('should clamp negative scores to 0', async () => {
      const negEvaluator: Evaluator = {
        generate: vi.fn(async () => ''),
        score: vi.fn(async () => -0.5),
      };
      const negPeer = new SwarmPeer(peerId('neg'), negEvaluator);
      const proposal: Proposal = {
        id: proposalId('p-1'),
        taskId: taskId('t'),
        peerId: peerId('other'),
        text: 'test',
        generationTimeMs: 0,
      };

      const evaluation = await negPeer.evaluateProposal('prompt', proposal);
      expect(evaluation.score).toBe(0);
    });
  });

  describe('known peers management', () => {
    it('should start with no known peers', () => {
      expect(peer.knownPeerIds).toEqual([]);
    });

    it('should add and retrieve known peers', () => {
      peer.addKnownPeer(peerId('peer-2'));
      peer.addKnownPeer(peerId('peer-3'));
      expect(peer.knownPeerIds).toContain(peerId('peer-2'));
      expect(peer.knownPeerIds).toContain(peerId('peer-3'));
    });

    it('should not duplicate known peers', () => {
      peer.addKnownPeer(peerId('peer-2'));
      peer.addKnownPeer(peerId('peer-2'));
      expect(peer.knownPeerIds.length).toBe(1);
    });

    it('should remove known peers', () => {
      peer.addKnownPeer(peerId('peer-2'));
      peer.removeKnownPeer(peerId('peer-2'));
      expect(peer.knownPeerIds).toEqual([]);
    });

    it('should select random gossip targets', () => {
      peer.addKnownPeer(peerId('p2'));
      peer.addKnownPeer(peerId('p3'));
      peer.addKnownPeer(peerId('p4'));
      peer.addKnownPeer(peerId('p5'));

      // With fanout=2, should return 2 random peers
      const targets = peer.selectGossipTargets(2);
      expect(targets.length).toBe(2);
      // All targets should be known peers
      for (const t of targets) {
        expect(peer.knownPeerIds).toContain(t);
      }
    });

    it('should return all peers if fanout exceeds known count', () => {
      peer.addKnownPeer(peerId('p2'));
      const targets = peer.selectGossipTargets(5);
      expect(targets.length).toBe(1);
      expect(targets[0]).toBe(peerId('p2'));
    });
  });
});
