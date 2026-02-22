/**
 * Swarm Intelligence module for distributed LLM inference.
 *
 * See SWARM.md for architecture design and rationale.
 */

export {
  type PeerId,
  type TaskId,
  type ProposalId,
  type SwarmConfig,
  type PeerInfo,
  type Proposal,
  type Evaluation,
  type SwarmResult,
  peerId,
  taskId,
  proposalId,
  PeerStatus,
  DEFAULT_SWARM_CONFIG,
} from './types.js';

export { SwarmPeer, type Evaluator } from './peer.js';
export { GossipProtocol } from './gossip.js';
export { SwarmConsensus, type ConsensusWinner } from './consensus.js';
export { Swarm, SwarmError } from './swarm.js';
