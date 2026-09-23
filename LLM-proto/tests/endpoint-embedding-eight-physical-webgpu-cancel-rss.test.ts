import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ENDPOINT_EMBEDDING_EIGHT_PHYSICAL_BROWSER_EXPECTED,
  ENDPOINT_EMBEDDING_EIGHT_PHYSICAL_EXPECTED,
} from '../browser-harness/endpoint-embedding-eight-physical-webgpu/contract.js';
import {
  classifyCancellationObservation,
  parseCancelCaptureArgs,
  preflightCancellationRssCapture,
} from '../tools/capture_endpoint_embedding_eight_physical_webgpu_cancel_rss.mjs';
import {
  calculateEndpointEmbeddingPayloadSetSha256,
} from '../tools/preflight_endpoint_embedding_eight_physical_bundle.mjs';

function payloadSha(index: number) {
  return (index + 1).toString(16).padStart(64, '0');
}

function validPreflightReport() {
  const expected = ENDPOINT_EMBEDDING_EIGHT_PHYSICAL_EXPECTED;
  const payloads = Array.from({ length: expected.candidatePhysicalArtifactCount }, (_, index) => ({
    index,
    file: `payload-${String(index).padStart(4, '0')}.bin`,
    bytes: expected.tileBytes,
    sha256: payloadSha(index),
    sourceOffsetBytes: index * expected.tileBytes,
    sourceEndOffsetBytesExclusive: (index + 1) * expected.tileBytes,
  }));
  const runtimePlan = payloads.map((payload, index) => ({
    tileIndex: index,
    startRow: index * expected.rowsPerTile,
    endRowExclusive: (index + 1) * expected.rowsPerTile,
    physicalArtifactIndex: index,
    payloadFile: payload.file,
    expectedPayloadBytes: payload.bytes,
    expectedPayloadSha256: payload.sha256,
    sourceOffsetBytes: payload.sourceOffsetBytes,
    sourceEndOffsetBytesExclusive: payload.sourceEndOffsetBytesExclusive,
    graphFile: expected.graphFile,
    expectedGraphBytes: expected.graphBytes,
    expectedGraphSha256: expected.graphSha256,
    graphExternalDataPath: expected.graphExternalDataPath,
    artifactByteOffset: 0,
    byteLength: expected.tileBytes,
  }));

  return {
    kind: ENDPOINT_EMBEDDING_EIGHT_PHYSICAL_BROWSER_EXPECTED.preflightKind,
    schemaVersion: ENDPOINT_EMBEDDING_EIGHT_PHYSICAL_BROWSER_EXPECTED.schemaVersion,
    status: 'pass',
    decisionStatus: 'diagnostic-only',
    selectedPhysicalArtifactCount: null,
    candidatePhysicalArtifactCount: expected.candidatePhysicalArtifactCount,
    sourceGraphSha256: expected.sourceGraphSha256,
    sourceExternalData: { ...expected.sourceExternalData },
    manifestPayloadSetSha256: calculateEndpointEmbeddingPayloadSetSha256(payloads),
    graph: {
      file: expected.graphFile,
      bytes: expected.graphBytes,
      sha256: expected.graphSha256,
    },
    payloads,
    runtimePlan,
    evidenceBoundary: ENDPOINT_EMBEDDING_EIGHT_PHYSICAL_BROWSER_EXPECTED.evidenceBoundary,
    conclusion: 'fixture preflight',
  };
}

describe('8-physical WebGPU cancellation RSS capture configuration', () => {
  it('uses isolated defaults and resolves the required paths', () => {
    const config = parseCancelCaptureArgs(
      ['relative-data', 'preflight.json', 'embedding-offset-0.onnx', 'cancel.json', '3'],
      {},
    );
    expect(config.serverPort).toBe(8798);
    expect(config.debugPort).toBe(9338);
    expect(config.sampleIntervalMs).toBe(100);
    expect(config.postCancelSettleMs).toBe(30000);
    expect(config.timeoutMs).toBe(180000);
    expect(config.cancelTile).toBe(3);
    expect(config.dataDir).toMatch(/relative-data$/);
    expect(config.preflightReport).toMatch(/preflight\.json$/);
    expect(config.graphPath).toMatch(/embedding-offset-0\.onnx$/);
    expect(config.outputPath).toMatch(/cancel\.json$/);
  });

  it('accepts every valid tile boundary and explicit safe integer overrides', () => {
    const zero = parseCancelCaptureArgs(['data', 'preflight', 'graph', 'output', '0'], {
      CHROME_BINARY: '/custom/chrome',
      UNZEN_HARNESS_PORT: '12021',
      UNZEN_CDP_PORT: '12022',
      UNZEN_RSS_SAMPLE_INTERVAL_MS: '25',
      UNZEN_RSS_POST_CANCEL_SETTLE_MS: '0',
      UNZEN_RSS_TIMEOUT_MS: '240000',
    });
    expect(zero).toMatchObject({
      chromeBinary: '/custom/chrome',
      serverPort: 12021,
      debugPort: 12022,
      sampleIntervalMs: 25,
      postCancelSettleMs: 0,
      timeoutMs: 240000,
      cancelTile: 0,
    });
    expect(parseCancelCaptureArgs(['data', 'preflight', 'graph', 'output', '7'], {}).cancelTile).toBe(7);
  });

  it.each([
    ['UNZEN_HARNESS_PORT', '0'],
    ['UNZEN_HARNESS_PORT', '65536'],
    ['UNZEN_CDP_PORT', 'NaN'],
    ['UNZEN_RSS_SAMPLE_INTERVAL_MS', '0'],
    ['UNZEN_RSS_SAMPLE_INTERVAL_MS', '1.5'],
    ['UNZEN_RSS_POST_CANCEL_SETTLE_MS', '-1'],
    ['UNZEN_RSS_POST_CANCEL_SETTLE_MS', ''],
    ['UNZEN_RSS_TIMEOUT_MS', '-5'],
  ])('rejects malformed %s=%j before capture startup', (name, value) => {
    expect(() => parseCancelCaptureArgs(
      ['data', 'preflight', 'graph', 'output', '3'],
      { [name]: value },
    )).toThrow(new RegExp(name));
  });

  it.each(['-1', '8', '1.5', 'NaN', ''])('rejects invalid CANCEL_TILE=%j', (value) => {
    expect(() => parseCancelCaptureArgs(
      ['data', 'preflight', 'graph', 'output', value],
      {},
    )).toThrow(/CANCEL_TILE/);
  });

  it('rejects port collisions and missing positional arguments', () => {
    expect(() => parseCancelCaptureArgs(
      ['data', 'preflight', 'graph', 'output', '3'],
      { UNZEN_HARNESS_PORT: '12021', UNZEN_CDP_PORT: '12021' },
    )).toThrow(/must be distinct/);
    expect(() => parseCancelCaptureArgs(['data', 'preflight', 'graph', 'output'], {})).toThrow(/usage:/);
  });

  it('rejects a direct OUTPUT_JSON/input alias before creating the output parent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'unzen-direct-cancel-rss-alias-test-'));
    try {
      const dataDir = join(root, 'data');
      mkdirSync(dataDir);
      const preflightReport = join(root, 'preflight.json');
      writeFileSync(preflightReport, `${JSON.stringify(validPreflightReport())}\n`, 'utf8');
      const outputParent = join(root, 'must-not-be-created');
      const graphPath = join(outputParent, 'embedding-offset-0.onnx');
      await expect(preflightCancellationRssCapture({
        dataDir,
        preflightReport,
        graphPath,
        outputPath: graphPath,
      })).rejects.toThrow('OUTPUT_JSON must not alias validated input GRAPH_PATH');
      expect(existsSync(outputParent)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('validates direct output aliases before any capture side effect', () => {
    const source = readFileSync(
      new URL('../tools/capture_endpoint_embedding_eight_physical_webgpu_cancel_rss.mjs', import.meta.url),
      'utf8',
    );
    const preflightStart = source.indexOf('export async function preflightCancellationRssCapture');
    const read = source.indexOf('await readRegularJsonFile(config.preflightReport)', preflightStart);
    const validate = source.indexOf('validateEndpointEmbeddingEightPhysicalPreflightReport(', preflightStart);
    const guard = source.indexOf('assertCancellationRssOutputPathsDoNotAliasInputs(config, preflight', preflightStart);
    const runStart = source.indexOf('async function runCapture(config)');
    const preflightCall = source.indexOf('await preflightCancellationRssCapture(config);', runStart);
    const mkdir = source.indexOf('mkdirSync(dirname(config.outputPath)', runStart);
    const profile = source.indexOf('mkdtempSync(', runStart);
    const server = source.indexOf('const server = spawn(process.execPath', runStart);
    expect(preflightStart).toBeGreaterThanOrEqual(0);
    expect(validate).toBeGreaterThanOrEqual(preflightStart);
    expect(read).toBeGreaterThan(validate);
    expect(guard).toBeGreaterThan(read);
    expect(runStart).toBeGreaterThan(guard);
    expect(preflightCall).toBeGreaterThan(runStart);
    expect(mkdir).toBeGreaterThan(preflightCall);
    expect(profile).toBeGreaterThan(mkdir);
    expect(server).toBeGreaterThan(profile);
  });
});

describe('8-physical WebGPU cancellation trigger classification', () => {
  it('cancels only on the exact configured execution phase', () => {
    expect(classifyCancellationObservation(
      { phase: 'executing embedding tile 3', report: null },
      3,
    )).toEqual({
      action: 'cancel',
      phase: 'executing embedding tile 3',
      targetTile: 3,
    });

    expect(classifyCancellationObservation(
      { phase: 'loading and verifying physical payload 3', report: null },
      3,
    )).toEqual({ action: 'continue' });
  });

  it('fails closed if the harness reports a failure before cancellation', () => {
    const result = classifyCancellationObservation({
      phase: 'executing embedding tile 2',
      report: { status: 'fail', error: 'WebGPU device lost' },
    }, 3);
    expect(result.action).toBe('fail');
    expect(result.reason).toMatch(/WebGPU device lost/);
  });

  it('fails closed if a passing report exists even when the phase text matches', () => {
    const result = classifyCancellationObservation({
      phase: 'executing embedding tile 3',
      report: { status: 'pass' },
    }, 3);
    expect(result.action).toBe('fail');
    expect(result.reason).toMatch(/completed before cancellation/);
  });

  it('fails closed when the target execution phase was missed', () => {
    expect(classifyCancellationObservation(
      { phase: 'loading and verifying physical payload 4', report: null },
      3,
    )).toMatchObject({ action: 'fail' });
    expect(classifyCancellationObservation(
      { phase: 'executing embedding tile 4', report: null },
      3,
    )).toMatchObject({ action: 'fail' });
  });

  it('continues through earlier phases without claiming cancellation evidence', () => {
    for (const phase of [
      null,
      'loading validated actual-file preflight report',
      'loading and verifying pinned zero-offset graph',
      'loading and verifying physical payload 1',
      'executing embedding tile 1',
      'loading and verifying physical payload 3',
    ]) {
      expect(classifyCancellationObservation({ phase, report: null }, 3)).toEqual({ action: 'continue' });
    }
  });

  it('rejects malformed observations and target tiles', () => {
    expect(() => classifyCancellationObservation(null, 3)).toThrow(/state must be an object/);
    expect(() => classifyCancellationObservation({ phase: null, report: null }, 8)).toThrow(/targetTile/);
  });
});
