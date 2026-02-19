/**
 * SpanRouter: Petals-inspired routing that assigns contiguous segment spans to workers.
 *
 * In Petals, a single GPU server can host a "span" of consecutive transformer blocks
 * (e.g., blocks 0-15 of 80). The client uses Dijkstra/greedy routing to find the
 * optimal path through available spans, minimizing the number of inter-node hops.
 *
 * This module adapts that pattern for browser workers:
 * - A worker with 8GB VRAM can handle 4 segments (4 × 2.1GB) as a single span
 * - Fewer spans = fewer checkpoint transfers = lower total latency
 * - Tier 1/2 workers (more stable) are preferred for larger spans (PLAN.md 4.5.3)
 *
 * The routing algorithm is greedy: sort workers by quality, then assign each the
 * maximum contiguous segment range their VRAM allows. Petals uses Dijkstra for
 * global optimality, but the greedy approach is simpler and sufficient when the
 * Coordinator has full visibility of all workers (unlike Petals' DHT-based discovery).
 */

import type { WorkerId, WorkerInfo, SegmentConfig } from './types.js';
import { WorkerStatus } from './types.js';
import { WorkerPool } from './worker-pool.js';

/**
 * A span is a contiguous range of segments assigned to a single worker.
 * When a worker handles multiple segments as a span, no checkpoint transfer
 * occurs between those segments — the hidden states stay on the same device.
 */
export interface Span {
  readonly workerId: WorkerId;
  /** First segment index in this span (inclusive). */
  readonly startSegment: number;
  /** Last segment index in this span (inclusive). */
  readonly endSegment: number;
}

/** An ordered list of spans that covers all segments 0..N-1. */
export type Route = readonly Span[];

export class SpanRouter {
  constructor(
    private readonly segments: readonly SegmentConfig[],
    private readonly workerPool: WorkerPool,
  ) {}

  /**
   * Compute an optimal route that covers all segments [0, N-1].
   * Returns null if the available workers cannot cover all segments.
   *
   * Algorithm (Petals-inspired greedy):
   * 1. Collect idle workers and compute max span capacity for each
   * 2. Sort by tier (ascending = more stable first), then by capacity (descending)
   * 3. Greedily assign from the first unassigned segment:
   *    - Pick the best worker and give it as many contiguous segments as possible
   *    - Repeat until all segments are covered
   *
   * This minimizes checkpoint transfers because each span boundary is one
   * inter-node hop. Fewer, larger spans = fewer hops = lower latency.
   */
  computeRoute(): Route | null {
    if (this.segments.length === 0) return [];

    // The greedy algorithm assumes all segments have the same VRAM cost.
    // This holds for transformer blocks of uniform size (PLAN.md 5.1).
    const vramPerSegment = this.segments[0].estimatedVramMB;
    for (let i = 1; i < this.segments.length; i++) {
      if (this.segments[i].estimatedVramMB !== vramPerSegment) {
        throw new Error(
          `SpanRouter requires uniform estimatedVramMB: segment 0 has ${vramPerSegment}MB, ` +
          `segment ${i} has ${this.segments[i].estimatedVramMB}MB`,
        );
      }
    }
    const candidates = this.rankWorkers(vramPerSegment);
    if (candidates.length === 0) return null;

    const route: Span[] = [];
    let nextSegment = 0;
    const totalSegments = this.segments.length;
    // Track which workers have been assigned to avoid reuse
    const usedWorkers = new Set<WorkerId>();

    while (nextSegment < totalSegments) {
      // Find the best unused worker for the remaining segments
      const worker = candidates.find(
        (c) => !usedWorkers.has(c.worker.id),
      );
      if (!worker) return null; // Not enough workers to cover all segments

      // Assign as many contiguous segments as this worker's VRAM allows
      const spanSize = Math.min(worker.maxSpan, totalSegments - nextSegment);
      route.push({
        workerId: worker.worker.id,
        startSegment: nextSegment,
        endSegment: nextSegment + spanSize - 1,
      });

      usedWorkers.add(worker.worker.id);
      nextSegment += spanSize;
    }

    return route;
  }

  /**
   * Rank idle workers by suitability for span assignment.
   * Priority: lower tier > larger span capacity > more VRAM.
   */
  private rankWorkers(
    vramPerSegment: number,
  ): { worker: WorkerInfo; maxSpan: number }[] {
    const candidates: { worker: WorkerInfo; maxSpan: number }[] = [];

    for (const worker of this.workerPool.allWorkers()) {
      if (worker.status !== WorkerStatus.IDLE) continue;
      const maxSpan = Math.floor(worker.vramMB / vramPerSegment);
      if (maxSpan < 1) continue;
      candidates.push({ worker, maxSpan });
    }

    // Sort: tier ascending (Tier 1 first), then maxSpan descending, then VRAM descending
    candidates.sort((a, b) => {
      if (a.worker.tier !== b.worker.tier) return a.worker.tier - b.worker.tier;
      if (a.maxSpan !== b.maxSpan) return b.maxSpan - a.maxSpan;
      return b.worker.vramMB - a.worker.vramMB;
    });

    return candidates;
  }
}
