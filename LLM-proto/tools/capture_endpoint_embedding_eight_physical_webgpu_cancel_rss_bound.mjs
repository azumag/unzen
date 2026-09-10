#!/usr/bin/env node
/**
 * Run the existing 8-physical page-teardown cancellation RSS capture against a
 * validated immutable preflight snapshot, then emit a provenance-bound sidecar.
 *
 * The sidecar binds the cancellation envelope to the exact preflight-declared
 * graph and eight payload identities supplied to the harness invocation. It
 * remains diagnostic-only and does not turn process RSS into GPU device-memory
 * evidence.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ENDPOINT_EMBEDDING_EIGHT_PHYSICAL_BROWSER_EXPECTED,
  validateEndpointEmbeddingEightPhysicalPreflightReport,
} from '../browser-harness/endpoint-embedding-eight-physical-webgpu/contract.js';
import {
  calculateEndpointEmbeddingPayloadSetSha256,
  readRegularJsonFile,
} from './preflight_endpoint_embedding_eight_physical_bundle.mjs';
import {
  readStableCancellationRssEvidence,
  validateCancellationRssEvidence,
} from './verify_endpoint_embedding_eight_physical_webgpu_cancel_rss.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const CAPTURE_SCRIPT = resolve(
  SCRIPT_DIR,
  'capture_endpoint_embedding_eight_physical_webgpu_cancel_rss.mjs',
);

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function canonicalJsonSha256(value) {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

export function endpointEmbeddingEightPhysicalPreflightIdentity(preflightReport) {
  const report = validateEndpointEmbeddingEightPhysicalPreflightReport(preflightReport);
  const calculatedPayloadSetSha256 = calculateEndpointEmbeddingPayloadSetSha256(report.payloads);
  if (calculatedPayloadSetSha256 !== report.manifestPayloadSetSha256) {
    throw new Error('preflight.manifestPayloadSetSha256 does not match preflight.payloads');
  }
  return {
    identitySource: 'validated-preflight-report-snapshot-supplied-to-harness',
    preflightKind: report.kind,
    preflightSchemaVersion: report.schemaVersion,
    evidenceBoundary: report.evidenceBoundary,
    onnxruntimeWebVersion: ENDPOINT_EMBEDDING_EIGHT_PHYSICAL_BROWSER_EXPECTED.onnxruntimeWebVersion,
    sourceGraphSha256: report.sourceGraphSha256,
    sourceExternalData: { ...report.sourceExternalData },
    manifestPayloadSetSha256: report.manifestPayloadSetSha256,
    graph: {
      file: report.graph.file,
      bytes: report.graph.bytes,
      sha256: report.graph.sha256,
    },
    physicalArtifacts: report.payloads.map((payload) => ({
      index: payload.index,
      file: payload.file,
      bytes: payload.bytes,
      sha256: payload.sha256,
      sourceOffsetBytes: payload.sourceOffsetBytes,
      sourceEndOffsetBytesExclusive: payload.sourceEndOffsetBytesExclusive,
    })),
  };
}

export function buildBoundCancellationRssEvidence(cancellationEvidence, preflightReport) {
  const cancellation = validateCancellationRssEvidence(cancellationEvidence);
  const preflight = validateEndpointEmbeddingEightPhysicalPreflightReport(preflightReport);
  const runtimeIdentity = endpointEmbeddingEightPhysicalPreflightIdentity(preflight);

  return {
    schemaVersion: '1.0.0',
    kind: 'unzen-endpoint-embedding-eight-physical-webgpu-cancel-rss-preflight-bound-evidence',
    status: 'pass',
    decisionStatus: 'diagnostic-only',
    evidenceLevel: 'derived-captured-os-process-rss+validated-preflight-bundle-identity',
    sourceDocuments: {
      cancellationEvidenceCanonicalSha256: canonicalJsonSha256(cancellation),
      preflightReportCanonicalSha256: canonicalJsonSha256(preflight),
    },
    cancellation: {
      capturedAtUtc: cancellation.capturedAtUtc,
      targetTile: cancellation.cancellation.targetTile,
      expectedPhase: cancellation.cancellation.expectedPhase,
      observedPhase: cancellation.cancellation.observedPhase,
      method: cancellation.cancellation.method,
    },
    environment: {
      platform: cancellation.environment.platform,
      osRelease: cancellation.environment.osRelease,
      chromeVersion: cancellation.environment.chromeVersion,
      cdpBrowser: cancellation.environment.cdpBrowser,
    },
    runtimeIdentity,
    conclusion: (
      'The page-teardown cancellation RSS envelope is bound to the exact validated preflight '
      + 'snapshot supplied to the harness invocation. The graph, payload-set digest, and all eight '
      + 'preflight-declared physical payload identities are preserved for later same-bundle comparison.'
    ),
    limitations: [
      'This sidecar binds invocation provenance; it does not independently re-hash every prepared payload or prove GPU device-memory peak or allocator reclamation.',
      'The cancellation boundary remains coarse page teardown after observing a runner phase, not an ORT/WebGPU in-flight cancellation API.',
      'The ORT Web version is the pinned browser-harness contract version; the cancellation intentionally happens before a complete runtime report exists.',
      'The temporary preflight snapshot prevents accidental source-file drift during this wrapper invocation but is not an adversarial same-user filesystem isolation mechanism.',
      'Payloads after the cancellation target may not have been loaded by the browser; their identities are preserved from the validated preflight snapshot, not claimed as runtime-verified by this cancelled run.',
      'This evidence does not select the 8-physical layout or establish decoder/KV/checkpoint full-model equivalence or resume correctness.',
    ],
  };
}

function parseArgs(argv) {
  if (!Array.isArray(argv) || argv.length !== 6 || argv.some((value) => !value)) {
    throw new Error(
      'usage: capture_endpoint_embedding_eight_physical_webgpu_cancel_rss_bound.mjs '
      + 'DATA_DIR PREFLIGHT_REPORT GRAPH_PATH CANCELLATION_OUTPUT_JSON CANCEL_TILE BOUND_OUTPUT_JSON',
    );
  }
  const cancellationOutputPath = resolve(argv[3]);
  const boundOutputPath = resolve(argv[5]);
  if (cancellationOutputPath === boundOutputPath) {
    throw new Error('CANCELLATION_OUTPUT_JSON and BOUND_OUTPUT_JSON must be distinct');
  }
  return {
    dataDir: resolve(argv[0]),
    preflightReport: resolve(argv[1]),
    graphPath: resolve(argv[2]),
    cancellationOutputPath,
    cancelTile: argv[4],
    boundOutputPath,
  };
}

function reserveExclusiveOutput(outputPath) {
  mkdirSync(dirname(outputPath), { recursive: true });
  return openSync(outputPath, 'wx', 0o600);
}

export async function runBoundCancellationRssCapture(argv, env = process.env) {
  const config = parseArgs(argv);
  const preflight = validateEndpointEmbeddingEightPhysicalPreflightReport(
    await readRegularJsonFile(config.preflightReport),
  );
  endpointEmbeddingEightPhysicalPreflightIdentity(preflight);
  const preflightDigest = canonicalJsonSha256(preflight);
  const boundFd = reserveExclusiveOutput(config.boundOutputPath);
  let boundOutputCommitted = false;
  let boundFdOpen = true;
  let snapshotDir = null;

  try {
    snapshotDir = mkdtempSync(join(tmpdir(), 'unzen-cancel-rss-preflight-'));
    const snapshotPath = join(snapshotDir, 'preflight.snapshot.json');
    writeFileSync(snapshotPath, `${JSON.stringify(preflight, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    chmodSync(snapshotPath, 0o400);

    const result = spawnSync(process.execPath, [
      CAPTURE_SCRIPT,
      config.dataDir,
      snapshotPath,
      config.graphPath,
      config.cancellationOutputPath,
      config.cancelTile,
    ], {
      env,
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    if (result.signal) throw new Error(`cancellation capture terminated by signal ${result.signal}`);
    if (result.status !== 0) throw new Error(`cancellation capture exited with status ${result.status}`);

    const snapshotAfter = validateEndpointEmbeddingEightPhysicalPreflightReport(
      await readRegularJsonFile(snapshotPath),
    );
    endpointEmbeddingEightPhysicalPreflightIdentity(snapshotAfter);
    if (canonicalJsonSha256(snapshotAfter) !== preflightDigest) {
      throw new Error('validated preflight snapshot changed during cancellation capture');
    }

    const cancellation = readStableCancellationRssEvidence(config.cancellationOutputPath);
    const bound = buildBoundCancellationRssEvidence(cancellation, snapshotAfter);
    writeFileSync(boundFd, `${JSON.stringify(bound, null, 2)}\n`, 'utf8');
    closeSync(boundFd);
    boundFdOpen = false;
    boundOutputCommitted = true;
    return bound;
  } finally {
    if (boundFdOpen) closeSync(boundFd);
    if (!boundOutputCommitted) rmSync(config.boundOutputPath, { force: true });
    if (snapshotDir !== null) rmSync(snapshotDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runBoundCancellationRssCapture(process.argv.slice(2)).then((report) => {
    process.stdout.write(`${JSON.stringify({
      status: report.status,
      targetTile: report.cancellation.targetTile,
      manifestPayloadSetSha256: report.runtimeIdentity.manifestPayloadSetSha256,
      cancellationEvidenceCanonicalSha256: report.sourceDocuments.cancellationEvidenceCanonicalSha256,
      preflightReportCanonicalSha256: report.sourceDocuments.preflightReportCanonicalSha256,
    }, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
