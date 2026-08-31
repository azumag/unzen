/**
 * SpanRouter: Petals-inspired routing that assigns contiguous segment spans to workers.
 *
 * In Petals, a single GPU server can host a "span" of consecutive transformer blocks
 * (e.g., blocks 0-15 of 80). The client uses Dijkstra/greedy routing to find the
 * optimal path through available spans, minimizing the number of inter-node hops.
 *
 * This module adapts that pattern for browser workers:
 * - a worker receives the longest contiguous span that fits its current VRAM;
 * - manifest-backed cache residency is preferred so adjacent cached artifacts
 *   become one SpanPipeline assignment rather than repeated cold downloads;
 * - fewer spans mean fewer Coordinator checkpoint transfers;
 * - Tier 1/2 workers remain the fallback priority when cache locality is equal.
 */

import type { ArtifactResidencyLedger } from './artifact-residency-ledger.js';
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

/** An ordered list of spans that covers one contiguous suffix of the model. */
export type Route = readonly Span[];

interface RankedWorker {
  readonly worker: WorkerInfo;
  readonly maxSpan: number;
  readonly residentPrefixLength: number;
  readonly residentArtifactBytes: number;
  readonly missingArtifactBytes: number;
}

export class SpanRouter {
  constructor(
    private readonly segments: readonly SegmentConfig[],
    private readonly workerPool: WorkerPool,
    private readonly artifactResidencyLedger?: ArtifactResidencyLedger,
  ) {
    for (const [arrayIndex, segment] of segments.entries()) {
      if (segment.index !== arrayIndex) {
        throw new Error(
          `SpanRouter requires segment indexes 0..n-1; ` +
          `expected ${arrayIndex}, found ${segment.index}`,
        );
      }
      if (!Number.isFinite(segment.estimatedVramMB) || segment.estimatedVramMB <= 0) {
        throw new Error(
          `segment ${segment.index} estimatedVramMB must be a positive finite number`,
        );
      }
    }
    this.artifactResidencyLedger?.assertCompatibleSegments(segments);
  }

  /**
   * Compute a route that covers `[startSegment, N-1]`. Returns null if the
   * currently idle workers cannot cover that suffix.
   *
   * A non-zero start is the durable-checkpoint resume path: earlier segments
   * are already complete and must not be routed again. Routing is recalculated
   * at every boundary because byte-budgeted ONNX shards can have unequal VRAM
   * estimates. With an artifact ledger, workers that already hold a contiguous
   * prefix at the current boundary are ranked ahead of cold workers;
   * equal-locality candidates retain stable tier/capacity ordering.
   */
  computeRoute(startSegment = 0): Route | null {
    if (
      !Number.isInteger(startSegment) ||
      startSegment < 0 ||
      startSegment > this.segments.length
    ) {
      throw new Error(
        `startSegment must be an integer between 0 and ${this.segments.length}; ` +
        `found ${startSegment}`,
      );
    }
    if (startSegment === this.segments.length) return [];

    const route: Span[] = [];
    const usedWorkers = new Set<WorkerId>();
    let nextSegment = startSegment;

    while (nextSegment < this.segments.length) {
      const candidates = this.rankWorkers(nextSegment, usedWorkers);
      const selected = candidates[0];
      if (!selected) return null;

      const spanSize = Math.min(
        selected.maxSpan,
        this.segments.length - nextSegment,
      );
      route.push({
        workerId: selected.worker.id,
        startSegment: nextSegment,
        endSegment: nextSegment + spanSize - 1,
      });
      usedWorkers.add(selected.worker.id);
      nextSegment += spanSize;
    }

    return route;
  }

  /** Rank idle, unused workers for the current segment boundary. */
  private rankWorkers(
    startSegment: number,
    usedWorkers: ReadonlySet<WorkerId>,
  ): RankedWorker[] {
    const candidates: RankedWorker[] = [];

    for (const worker of this.workerPool.allWorkers()) {
      if (worker.status !== WorkerStatus.IDLE || usedWorkers.has(worker.id)) continue;
      const maxSpan = this.computeMaximumSpan(worker, startSegment);
      if (maxSpan < 1) continue;

      const endSegment = startSegment + maxSpan - 1;
      const residentPrefixLength = this.artifactResidencyLedger?.residentPrefixLength(
        worker.id,
        startSegment,
        maxSpan,
      ) ?? 0;
      const residentArtifactBytes = this.artifactResidencyLedger?.residentArtifactBytes(
        worker.id,
        startSegment,
        endSegment,
      ) ?? 0;
      const missingArtifactBytes = this.artifactResidencyLedger?.missingArtifactBytes(
        worker.id,
        startSegment,
        endSegment,
      ) ?? 0;
      candidates.push({
        worker,
        maxSpan,
        residentPrefixLength,
        residentArtifactBytes,
        missingArtifactBytes,
      });
    }

    candidates.sort((left, right) => {
      if (this.artifactResidencyLedger !== undefined) {
        // Contiguous locality matters first: it is the part that can execute
        // inside one SpanPipeline assignment without a cold artifact fetch.
        if (left.residentPrefixLength !== right.residentPrefixLength) {
          return right.residentPrefixLength - left.residentPrefixLength;
        }
        if (left.residentArtifactBytes !== right.residentArtifactBytes) {
          return right.residentArtifactBytes - left.residentArtifactBytes;
        }
        if (left.missingArtifactBytes !== right.missingArtifactBytes) {
          return left.missingArtifactBytes - right.missingArtifactBytes;
        }
      }
      if (left.worker.tier !== right.worker.tier) {
        return left.worker.tier - right.worker.tier;
      }
      if (left.maxSpan !== right.maxSpan) {
        return right.maxSpan - left.maxSpan;
      }
      if (left.worker.vramMB !== right.worker.vramMB) {
        return right.worker.vramMB - left.worker.vramMB;
      }
      return left.worker.id.localeCompare(right.worker.id);
    });

    return candidates;
  }

  /**
   * Sum each actual segment estimate until the next artifact would exceed the
   * worker's VRAM. This replaces the old segment-0 multiplication assumption,
   * which was unsafe for unequal first/last shards from an automatic splitter.
   */
  private computeMaximumSpan(worker: WorkerInfo, startSegment: number): number {
    let consumedVramMB = 0;
    let spanLength = 0;
    for (let index = startSegment; index < this.segments.length; index++) {
      const nextVramMB = this.segments[index].estimatedVramMB;
      if (consumedVramMB + nextVramMB > worker.vramMB) break;
      consumedVramMB += nextVramMB;
      spanLength++;
    }
    return spanLength;
  }
}
