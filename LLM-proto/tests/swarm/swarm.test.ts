import { describe, it, expect, vi } from 'vitest';
import { Swarm } from '../../src/swarm/swarm.js';
import { SwarmPeer, type Evaluator } from '../../src/swarm/peer.js';
import {
  peerId,
  DEFAULT_SWARM_CONFIG,
  type SwarmConfig,
} from '../../src/swarm/types.js';

/**
 * Create a mock evaluator that returns deterministic text and scores.
 * @param quality - higher quality peers produce longer (higher-scored) responses
 */
function mockEvaluator(quality: number): Evaluator {
  return {
    generate: vi.fn(async (prompt: string) => {
      // Higher quality peers produce more detailed answers
      const base = `Answer to: ${prompt}`;
      return base + ' detail'.repeat(Math.floor(quality * 10));
    }),
    score: vi.fn(async (_prompt: string, candidate: string) => {
      // Score based on response length (proxy for quality)
      return Math.min(candidate.length / 200, 1.0);
    }),
  };
}

function makeConfig(overrides?: Partial<SwarmConfig>): SwarmConfig {
  return {
    ...DEFAULT_SWARM_CONFIG,
    // Shorter timeouts for tests
    proposalTimeoutMs: 5_000,
    evaluationTimeoutMs: 5_000,
    ...overrides,
  };
}

describe('Swarm', () => {
  describe('config validation', () => {
    it('should reject minPeers < 2', () => {
      expect(() => new Swarm(makeConfig({ minPeers: 1 }))).toThrow(
        'minPeers must be >= 2',
      );
    });

    it('should reject maxPeers < minPeers', () => {
      expect(
        () => new Swarm(makeConfig({ minPeers: 5, maxPeers: 3 })),
      ).toThrow('maxPeers');
    });

    it('should reject consensusThreshold <= 0', () => {
      expect(
        () => new Swarm(makeConfig({ consensusThreshold: 0 })),
      ).toThrow('consensusThreshold');
    });

    it('should reject consensusThreshold > 1', () => {
      expect(
        () => new Swarm(makeConfig({ consensusThreshold: 1.5 })),
      ).toThrow('consensusThreshold');
    });
  });

  describe('peer management', () => {
    it('should register and track peers', () => {
      const config = makeConfig({ minPeers: 2 });
      const swarm = new Swarm(config);

      const peer1 = new SwarmPeer(peerId('p1'), mockEvaluator(0.5));
      const peer2 = new SwarmPeer(peerId('p2'), mockEvaluator(0.7));

      swarm.addPeer(peer1);
      swarm.addPeer(peer2);

      expect(swarm.peerCount).toBe(2);
    });

    it('should remove peers', () => {
      const config = makeConfig({ minPeers: 2 });
      const swarm = new Swarm(config);
      const peer1 = new SwarmPeer(peerId('p1'), mockEvaluator(0.5));

      swarm.addPeer(peer1);
      swarm.removePeer(peerId('p1'));

      expect(swarm.peerCount).toBe(0);
    });
  });

  describe('submitTask', () => {
    it('should fail if fewer peers than minPeers', async () => {
      const config = makeConfig({ minPeers: 3 });
      const swarm = new Swarm(config);
      swarm.addPeer(new SwarmPeer(peerId('p1'), mockEvaluator(0.5)));
      swarm.addPeer(new SwarmPeer(peerId('p2'), mockEvaluator(0.5)));

      await expect(swarm.submitTask('What is 2+2?')).rejects.toThrow(
        'Not enough peers',
      );
    });

    it('should complete inference with 3 peers', async () => {
      const config = makeConfig({ minPeers: 3, maxPeers: 3 });
      const swarm = new Swarm(config);
      swarm.addPeer(new SwarmPeer(peerId('p1'), mockEvaluator(0.3)));
      swarm.addPeer(new SwarmPeer(peerId('p2'), mockEvaluator(0.7)));
      swarm.addPeer(new SwarmPeer(peerId('p3'), mockEvaluator(0.5)));

      const result = await swarm.submitTask('What is 2+2?');

      expect(result.text).toBeTruthy();
      expect(result.participantCount).toBe(3);
      expect(result.proposalCount).toBe(3);
      expect(result.consensusScore).toBeGreaterThan(0);
      expect(result.totalTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('should select the highest quality proposal', async () => {
      const config = makeConfig({
        minPeers: 3,
        maxPeers: 3,
        consensusThreshold: 0.1, // Low threshold to always get consensus
      });
      const swarm = new Swarm(config);

      // p2 generates significantly longer (higher quality) responses
      swarm.addPeer(new SwarmPeer(peerId('p1'), mockEvaluator(0.1)));
      swarm.addPeer(new SwarmPeer(peerId('p2'), mockEvaluator(0.9)));
      swarm.addPeer(new SwarmPeer(peerId('p3'), mockEvaluator(0.2)));

      const result = await swarm.submitTask('Explain gravity');

      // The best response should be selected (from the high-quality peer)
      expect(result.text).toContain('detail');
      expect(result.consensusScore).toBeGreaterThan(0.3);
    });

    it('should handle peers with equal quality gracefully', async () => {
      const config = makeConfig({
        minPeers: 3,
        maxPeers: 3,
        consensusThreshold: 0.1,
      });
      const swarm = new Swarm(config);

      // All peers produce equal quality
      swarm.addPeer(new SwarmPeer(peerId('p1'), mockEvaluator(0.5)));
      swarm.addPeer(new SwarmPeer(peerId('p2'), mockEvaluator(0.5)));
      swarm.addPeer(new SwarmPeer(peerId('p3'), mockEvaluator(0.5)));

      // Should still produce a result even without clear consensus
      const result = await swarm.submitTask('Test prompt');
      expect(result.text).toBeTruthy();
      expect(result.participantCount).toBe(3);
    });

    it('should limit participants to maxPeers', async () => {
      const config = makeConfig({ minPeers: 2, maxPeers: 3 });
      const swarm = new Swarm(config);

      // Add more peers than maxPeers
      for (let i = 0; i < 5; i++) {
        swarm.addPeer(new SwarmPeer(peerId(`p${i}`), mockEvaluator(0.5)));
      }

      const result = await swarm.submitTask('Test');
      expect(result.participantCount).toBeLessThanOrEqual(3);
    });
  });

  describe('error resilience', () => {
    it('should still produce result when one peer fails generation', async () => {
      const config = makeConfig({
        minPeers: 3,
        maxPeers: 4,
        consensusThreshold: 0.1,
      });
      const swarm = new Swarm(config);

      // One peer always fails
      const failEvaluator: Evaluator = {
        generate: vi.fn(async () => {
          throw new Error('WebGPU lost');
        }),
        score: vi.fn(async () => 0.5),
      };

      swarm.addPeer(new SwarmPeer(peerId('good1'), mockEvaluator(0.5)));
      swarm.addPeer(new SwarmPeer(peerId('good2'), mockEvaluator(0.7)));
      swarm.addPeer(new SwarmPeer(peerId('good3'), mockEvaluator(0.6)));
      swarm.addPeer(new SwarmPeer(peerId('fail'), failEvaluator));

      const result = await swarm.submitTask('Test');
      // Should succeed with 3 good peers despite 1 failure
      expect(result.text).toBeTruthy();
      expect(result.proposalCount).toBeGreaterThanOrEqual(3);
    });

    it('should fail when too many peers fail', async () => {
      const config = makeConfig({ minPeers: 3, maxPeers: 3 });
      const swarm = new Swarm(config);

      const failEvaluator: Evaluator = {
        generate: vi.fn(async () => {
          throw new Error('WebGPU lost');
        }),
        score: vi.fn(async () => 0.5),
      };

      swarm.addPeer(new SwarmPeer(peerId('good'), mockEvaluator(0.5)));
      swarm.addPeer(new SwarmPeer(peerId('fail1'), failEvaluator));
      swarm.addPeer(new SwarmPeer(peerId('fail2'), failEvaluator));

      // Only 1 successful proposal out of 3 — below minPeers
      await expect(swarm.submitTask('Test')).rejects.toThrow();
    });
  });
});
