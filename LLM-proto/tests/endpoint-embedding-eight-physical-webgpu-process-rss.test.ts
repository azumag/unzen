import { describe, expect, it } from 'vitest';
import {
  parseCaptureArgs,
  validateEightPhysicalRuntimeReport,
} from '../tools/capture_endpoint_embedding_eight_physical_webgpu_process_rss.mjs';

function makeRuntimeReport() {
  const verifiedPhysicalArtifacts = Array.from({ length: 8 }, (_, index) => ({
    index,
    file: `payload-${String(index).padStart(4, '0')}.bin`,
    bytes: 131_334_144,
    sha256: index.toString(16).repeat(64).slice(0, 64),
  }));
  const executedTiles = verifiedPhysicalArtifacts.map((artifact, index) => ({
    tileIndex: index,
    physicalArtifactIndex: index,
    payloadFile: artifact.file,
    payloadSha256: artifact.sha256,
    artifactByteOffset: 0,
    byteLength: 131_334_144,
    comparison: {
      exactEqual: true,
      firstByteMismatch: -1,
      maxAbsDiff: 0,
      worstIndex: -1,
    },
    sessionCreateMs: 10 + index,
    runMs: 2 + index,
    sessionReleaseMs: 1 + index,
  }));
  return {
    schemaVersion: '1.0.0',
    kind: 'unzen-pinned-llama-1b-endpoint-embedding-eight-physical-ort-webgpu-runtime',
    status: 'pass',
    decisionStatus: 'diagnostic-only',
    selectedPhysicalArtifactCount: null,
    evidenceLevel: 'self-reported-runtime',
    onnxruntimeWebVersion: '1.22.0',
    manifestPayloadSetSha256: 'a'.repeat(64),
    verifiedGraph: {
      file: 'embedding-offset-0.onnx',
      bytes: 260,
      sha256: 'b'.repeat(64),
    },
    verifiedPhysicalArtifacts,
    executedTiles,
    completeEmbeddingComparison: {
      exactEqual: true,
      firstByteMismatch: -1,
      maxAbsDiff: 0,
      worstIndex: -1,
    },
    outputShape: [16, 2048],
    sequentialExecution: {
      tilesPerPhysicalArtifact: 1,
    },
    sessionReleaseApiCompleted: true,
  };
}

describe('8-physical WebGPU RSS runtime evidence validation', () => {
  it('accepts the exact diagnostic runtime contract', () => {
    const report = makeRuntimeReport();
    expect(validateEightPhysicalRuntimeReport(report)).toBe(report);
  });

  it.each([
    ['schemaVersion', '2.0.0'],
    ['status', 'fail'],
    ['decisionStatus', 'selected'],
    ['selectedPhysicalArtifactCount', 8],
    ['evidenceLevel', 'captured-os-process-rss'],
    ['onnxruntimeWebVersion', '1.23.0'],
    ['sessionReleaseApiCompleted', false],
  ])('rejects invalid top-level %s', (field, value) => {
    const report = makeRuntimeReport() as Record<string, unknown>;
    report[field] = value;
    expect(() => validateEightPhysicalRuntimeReport(report)).toThrow();
  });

  it('rejects non-canonical payload-set and graph hashes', () => {
    const badPayloadSet = makeRuntimeReport();
    badPayloadSet.manifestPayloadSetSha256 = 'ABC';
    expect(() => validateEightPhysicalRuntimeReport(badPayloadSet)).toThrow(/canonical lowercase SHA-256/);

    const badGraph = makeRuntimeReport();
    badGraph.verifiedGraph.sha256 = 'g'.repeat(64);
    expect(() => validateEightPhysicalRuntimeReport(badGraph)).toThrow(/canonical lowercase SHA-256/);
  });

  it('rejects missing or extra physical artifacts and tiles', () => {
    const missingArtifact = makeRuntimeReport();
    missingArtifact.verifiedPhysicalArtifacts.pop();
    expect(() => validateEightPhysicalRuntimeReport(missingArtifact)).toThrow(/exactly 8/);

    const extraTile = makeRuntimeReport();
    extraTile.executedTiles.push({ ...extraTile.executedTiles[0] });
    expect(() => validateEightPhysicalRuntimeReport(extraTile)).toThrow(/exactly 8/);
  });

  it('rejects reordered, malformed, or cross-routed payload evidence', () => {
    const reordered = makeRuntimeReport();
    [reordered.verifiedPhysicalArtifacts[0], reordered.verifiedPhysicalArtifacts[1]] = [
      reordered.verifiedPhysicalArtifacts[1],
      reordered.verifiedPhysicalArtifacts[0],
    ];
    expect(() => validateEightPhysicalRuntimeReport(reordered)).toThrow(/identity mismatch/);

    const wrongGeometry = makeRuntimeReport();
    wrongGeometry.verifiedPhysicalArtifacts[2].bytes -= 4;
    expect(() => validateEightPhysicalRuntimeReport(wrongGeometry)).toThrow(/geometry mismatch/);

    const wrongHash = makeRuntimeReport();
    wrongHash.verifiedPhysicalArtifacts[2].sha256 = 'not-a-hash';
    expect(() => validateEightPhysicalRuntimeReport(wrongHash)).toThrow(/canonical lowercase SHA-256/);

    const crossRouted = makeRuntimeReport();
    crossRouted.executedTiles[3].payloadFile = crossRouted.verifiedPhysicalArtifacts[4].file;
    expect(() => validateEightPhysicalRuntimeReport(crossRouted)).toThrow(/payload identity mismatch/);
  });

  it('rejects non-zero offsets and wrong tile byte geometry', () => {
    const badOffset = makeRuntimeReport();
    badOffset.executedTiles[1].artifactByteOffset = 4;
    expect(() => validateEightPhysicalRuntimeReport(badOffset)).toThrow(/byte geometry mismatch/);

    const badLength = makeRuntimeReport();
    badLength.executedTiles[1].byteLength -= 4;
    expect(() => validateEightPhysicalRuntimeReport(badLength)).toThrow(/byte geometry mismatch/);
  });

  it('rejects non-byte-exact tile and complete comparisons', () => {
    const tileMismatch = makeRuntimeReport();
    tileMismatch.executedTiles[2].comparison.exactEqual = false;
    tileMismatch.executedTiles[2].comparison.firstByteMismatch = 0;
    expect(() => validateEightPhysicalRuntimeReport(tileMismatch)).toThrow(/byte-exact/);

    const completeMismatch = makeRuntimeReport();
    completeMismatch.completeEmbeddingComparison.exactEqual = false;
    completeMismatch.completeEmbeddingComparison.firstByteMismatch = 4;
    expect(() => validateEightPhysicalRuntimeReport(completeMismatch)).toThrow(/complete embedding/);
  });

  it('rejects invalid timing and output geometry', () => {
    const badTiming = makeRuntimeReport();
    badTiming.executedTiles[5].runMs = Number.NaN;
    expect(() => validateEightPhysicalRuntimeReport(badTiming)).toThrow(/timing/);

    const badShape = makeRuntimeReport();
    badShape.outputShape = [8, 2048];
    expect(() => validateEightPhysicalRuntimeReport(badShape)).toThrow(/outputShape/);

    const badRouting = makeRuntimeReport();
    badRouting.sequentialExecution.tilesPerPhysicalArtifact = 2;
    expect(() => validateEightPhysicalRuntimeReport(badRouting)).toThrow(/one tile/);
  });
});

describe('8-physical WebGPU RSS capture configuration', () => {
  it('uses isolated defaults and resolves all required paths', () => {
    const config = parseCaptureArgs(
      ['relative-data', 'preflight.json', 'embedding-offset-0.onnx', 'capture.json'],
      {},
    );
    expect(config.serverPort).toBe(8797);
    expect(config.debugPort).toBe(9337);
    expect(config.sampleIntervalMs).toBe(100);
    expect(config.postReportSettleMs).toBe(5000);
    expect(config.postTeardownSettleMs).toBe(30000);
    expect(config.timeoutMs).toBe(180000);
    expect(config.dataDir).toMatch(/relative-data$/);
    expect(config.preflightReport).toMatch(/preflight\.json$/);
    expect(config.graphPath).toMatch(/embedding-offset-0\.onnx$/);
    expect(config.outputPath).toMatch(/capture\.json$/);
  });

  it('accepts explicit safe integer overrides including zero settle windows', () => {
    expect(parseCaptureArgs(['data', 'preflight', 'graph', 'output'], {
      CHROME_BINARY: '/custom/chrome',
      UNZEN_HARNESS_PORT: '12011',
      UNZEN_CDP_PORT: '12012',
      UNZEN_RSS_SAMPLE_INTERVAL_MS: '20',
      UNZEN_RSS_POST_REPORT_SETTLE_MS: '0',
      UNZEN_RSS_POST_TEARDOWN_SETTLE_MS: '45000',
      UNZEN_RSS_TIMEOUT_MS: '240000',
    })).toMatchObject({
      chromeBinary: '/custom/chrome',
      serverPort: 12011,
      debugPort: 12012,
      sampleIntervalMs: 20,
      postReportSettleMs: 0,
      postTeardownSettleMs: 45000,
      timeoutMs: 240000,
    });
  });

  it.each([
    ['UNZEN_HARNESS_PORT', '0'],
    ['UNZEN_HARNESS_PORT', '65536'],
    ['UNZEN_CDP_PORT', 'NaN'],
    ['UNZEN_RSS_SAMPLE_INTERVAL_MS', '0'],
    ['UNZEN_RSS_SAMPLE_INTERVAL_MS', '1.5'],
    ['UNZEN_RSS_POST_REPORT_SETTLE_MS', '-1'],
    ['UNZEN_RSS_POST_TEARDOWN_SETTLE_MS', ''],
    ['UNZEN_RSS_TIMEOUT_MS', '-5'],
  ])('rejects malformed %s=%j before capture startup', (name, value) => {
    expect(() => parseCaptureArgs(['data', 'preflight', 'graph', 'output'], { [name]: value }))
      .toThrow(new RegExp(name));
  });

  it('rejects port collisions and missing positional paths', () => {
    expect(() => parseCaptureArgs(['data', 'preflight', 'graph', 'output'], {
      UNZEN_HARNESS_PORT: '12011',
      UNZEN_CDP_PORT: '12011',
    })).toThrow(/must be distinct/);
    expect(() => parseCaptureArgs(['data', 'preflight', 'graph'], {})).toThrow(/usage:/);
  });
});
