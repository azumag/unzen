/**
 * Shared test factory functions used across pipeline and span-pipeline tests.
 */

import {
  inferenceRequestId,
  InferenceStatus,
} from '../src/types.js';
import type {
  InferenceRequest,
  SegmentConfig,
  Checkpoint,
} from '../src/types.js';

export function makeSegments(count: number, vramPerSegment = 2100): SegmentConfig[] {
  return Array.from({ length: count }, (_, i) => ({
    index: i,
    layerStart: i * 8,
    layerEnd: (i + 1) * 8 - 1,
    modelWeightHash: `sha256:seg-${i}`,
    estimatedVramMB: vramPerSegment,
  }));
}

export function makeRequest(
  totalSegments: number,
  currentSegment = 0,
  id = 'req-test',
): InferenceRequest {
  return {
    id: inferenceRequestId(id),
    prompt: 'test prompt',
    createdAt: Date.now(),
    status: InferenceStatus.QUEUED,
    currentSegment,
    totalSegments,
  };
}

export function makeCheckpoint(requestId: string, segmentIndex: number): Checkpoint {
  return {
    requestId: inferenceRequestId(requestId),
    segmentIndex,
    hiddenStates: new Uint8Array([segmentIndex]),
    metadata: {
      shape: [1, 128, 4096],
      dtype: 'float16',
      sequenceLength: 128,
      timestamp: Date.now(),
    },
  };
}
