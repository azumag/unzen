import { describe, expect, it } from 'vitest';
import { ArtifactResidencyLedger } from '../src/artifact-residency-ledger.js';
import { BROWSER_SEGMENT_ABSOLUTE_MAX_BYTES } from '../src/browser-segment-artifact-budget.js';
import type { SegmentArtifact } from '../src/model-manifest.js';

function artifact(byteSize: number): SegmentArtifact {
  return {
    index: 0,
    layerStart: 0,
    layerEnd: 3,
    byteSize,
    sha256: '1'.repeat(64),
    contentType: 'application/onnx',
    artifactLocator: 'https://cdn.unzen.local/models/test/segment-0.onnx',
    estimatedMemoryMB: 512,
    memoryBasis: 'measured',
    measurementConditions: 'browser budget regression fixture',
    compatibleRuntimes: ['onnxruntime-web'],
    minimumRuntimeVersion: '1.20.0',
  };
}

describe('ArtifactResidencyLedger browser artifact budget', () => {
  it('accepts the absolute browser ceiling as a usable degraded artifact', () => {
    const ledger = new ArtifactResidencyLedger([
      artifact(BROWSER_SEGMENT_ABSOLUTE_MAX_BYTES),
    ]);

    expect(ledger.totalArtifactBytes).toBe(BROWSER_SEGMENT_ABSOLUTE_MAX_BYTES);
  });

  it('rejects an otherwise valid artifact above the absolute browser ceiling', () => {
    expect(() => new ArtifactResidencyLedger([
      artifact(BROWSER_SEGMENT_ABSOLUTE_MAX_BYTES + 1),
    ])).toThrow(/exceeds browser artifact absolute budget/);
  });

  it('keeps structural byte-size validation ahead of budget classification', () => {
    expect(() => new ArtifactResidencyLedger([
      artifact(0),
    ])).toThrow(/byteSize must be a safe positive integer/);
  });
});
