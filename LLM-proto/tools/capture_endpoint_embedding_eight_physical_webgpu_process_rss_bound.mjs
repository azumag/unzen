#!/usr/bin/env node
/**
 * Run the existing 8-physical normal-completion RSS capture against a validated
 * immutable preflight snapshot, then emit raw evidence plus a provenance-bound
 * sidecar without overwriting caller-owned files.
 */

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  fsyncSync,
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
  validateEndpointEmbeddingEightPhysicalPreflightReport,
} from '../browser-harness/endpoint-embedding-eight-physical-webgpu/contract.js';
import {
  canonicalJsonSha256,
  endpointEmbeddingEightPhysicalPreflightIdentity,
} from './capture_endpoint_embedding_eight_physical_webgpu_cancel_rss_bound.mjs';
import { readRegularJsonFile } from './preflight_endpoint_embedding_eight_physical_bundle.mjs';
import {
  readStableProcessRssEvidence,
  validateProcessRssEvidence,
} from './verify_endpoint_embedding_eight_physical_webgpu_process_rss.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const CAPTURE_SCRIPT = resolve(
  SCRIPT_DIR,
  'capture_endpoint_embedding_eight_physical_webgpu_process_rss.mjs',
);

function exactIdentity(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label} does not match validated preflight identity`);
}

export function assertNormalRuntimeMatchesPreflight(processRssEvidence, preflightReport) {
  const evidence = validateProcessRssEvidence(processRssEvidence);
  const preflight = validateEndpointEmbeddingEightPhysicalPreflightReport(preflightReport);
  const identity = endpointEmbeddingEightPhysicalPreflightIdentity(preflight);
  const runtime = evidence.runtimeReport;

  exactIdentity(
    runtime.onnxruntimeWebVersion,
    identity.onnxruntimeWebVersion,
    'runtimeReport.onnxruntimeWebVersion',
  );
  exactIdentity(
    runtime.manifestPayloadSetSha256,
    identity.manifestPayloadSetSha256,
    'runtimeReport.manifestPayloadSetSha256',
  );
  exactIdentity(runtime.verifiedGraph.file, identity.graph.file, 'runtimeReport.verifiedGraph.file');
  exactIdentity(runtime.verifiedGraph.bytes, identity.graph.bytes, 'runtimeReport.verifiedGraph.bytes');
  exactIdentity(runtime.verifiedGraph.sha256, identity.graph.sha256, 'runtimeReport.verifiedGraph.sha256');

  if (runtime.verifiedPhysicalArtifacts.length !== identity.physicalArtifacts.length) {
    throw new Error('runtimeReport.verifiedPhysicalArtifacts count does not match validated preflight identity');
  }
  for (let index = 0; index < identity.physicalArtifacts.length; index += 1) {
    const actual = runtime.verifiedPhysicalArtifacts[index];
    const expected = identity.physicalArtifacts[index];
    exactIdentity(actual.index, expected.index, `runtimeReport.verifiedPhysicalArtifacts[${index}].index`);
    exactIdentity(actual.file, expected.file, `runtimeReport.verifiedPhysicalArtifacts[${index}].file`);
    exactIdentity(actual.bytes, expected.bytes, `runtimeReport.verifiedPhysicalArtifacts[${index}].bytes`);
    exactIdentity(actual.sha256, expected.sha256, `runtimeReport.verifiedPhysicalArtifacts[${index}].sha256`);
  }

  return {
    result: 'exact-runtime-report-match-to-validated-preflight-identity',
    onnxruntimeWebVersion: runtime.onnxruntimeWebVersion,
    manifestPayloadSetSha256: runtime.manifestPayloadSetSha256,
    graphMatched: true,
    verifiedPhysicalArtifactCount: runtime.verifiedPhysicalArtifacts.length,
    allPhysicalArtifactIdentitiesMatched: true,
    completeEmbeddingByteExact: runtime.completeEmbeddingComparison.exactEqual === true,
    sessionReleaseApiCompleted: runtime.sessionReleaseApiCompleted === true,
  };
}

export function buildBoundNormalRssEvidence(processRssEvidence, preflightReport) {
  const evidence = validateProcessRssEvidence(processRssEvidence);
  const preflight = validateEndpointEmbeddingEightPhysicalPreflightReport(preflightReport);
  const runtimeIdentity = endpointEmbeddingEightPhysicalPreflightIdentity(preflight);
  const runtimeVerification = assertNormalRuntimeMatchesPreflight(evidence, preflight);

  return {
    schemaVersion: '1.0.0',
    kind: 'unzen-endpoint-embedding-eight-physical-webgpu-normal-rss-preflight-bound-evidence',
    status: 'pass',
    decisionStatus: 'diagnostic-only',
    evidenceLevel: 'derived-captured-os-process-rss+runtime-report+validated-preflight-bundle-identity',
    sourceDocuments: {
      processRssEvidenceCanonicalSha256: canonicalJsonSha256(evidence),
      preflightReportCanonicalSha256: canonicalJsonSha256(preflight),
    },
    normalCompletion: {
      capturedAtUtc: evidence.capturedAtUtc,
      sessionReleaseApiCompleted: evidence.runtimeReport.sessionReleaseApiCompleted,
      completeEmbeddingByteExact: evidence.runtimeReport.completeEmbeddingComparison.exactEqual,
    },
    environment: {
      platform: evidence.environment.platform,
      osRelease: evidence.environment.osRelease,
      chromeVersion: evidence.environment.chromeVersion,
      cdpBrowser: evidence.environment.cdpBrowser,
    },
    runtimeIdentity,
    runtimeVerification,
    conclusion: (
      'The normal-completion process-RSS envelope is bound to the exact validated preflight '
      + 'snapshot supplied to the harness invocation, and the completed runtime report graph, '
      + 'payload-set digest, ORT Web version, and all eight physical payload identities exactly '
      + 'match that preflight identity.'
    ),
    limitations: [
      'This sidecar binds invocation provenance and validates the captured runtime report; it does not independently re-hash prepared payloads after capture.',
      'Process RSS and Chrome gpu-process RSS remain OS memory proxies, not direct WebGPU buffer, driver heap, VRAM, or GPU allocator accounting.',
      'A completed runtime report establishes identity/equivalence claims only for this endpoint-embedding diagnostic harness, not decoder/KV/checkpoint full-model staged execution.',
      'The temporary preflight snapshot prevents accidental source-file drift during this wrapper invocation but is not an adversarial same-user filesystem isolation mechanism.',
      'This evidence remains diagnostic-only and does not select the 8-physical layout or modify production artifact/runtime/cache/dispatcher policy.',
    ],
  };
}

function parseArgs(argv) {
  if (!Array.isArray(argv) || argv.length !== 5 || argv.some((value) => !value)) {
    throw new Error(
      'usage: capture_endpoint_embedding_eight_physical_webgpu_process_rss_bound.mjs '
      + 'DATA_DIR PREFLIGHT_REPORT GRAPH_PATH PROCESS_RSS_OUTPUT_JSON BOUND_OUTPUT_JSON',
    );
  }
  const config = {
    dataDir: resolve(argv[0]),
    preflightReport: resolve(argv[1]),
    graphPath: resolve(argv[2]),
    processRssOutputPath: resolve(argv[3]),
    boundOutputPath: resolve(argv[4]),
  };
  if (config.processRssOutputPath === config.boundOutputPath) {
    throw new Error('PROCESS_RSS_OUTPUT_JSON and BOUND_OUTPUT_JSON must be distinct');
  }
  for (const outputPath of [config.processRssOutputPath, config.boundOutputPath]) {
    if (outputPath === config.preflightReport || outputPath === config.graphPath) {
      throw new Error('output paths must not overwrite PREFLIGHT_REPORT or GRAPH_PATH');
    }
  }
  return config;
}

function reserveExclusiveOutput(outputPath) {
  mkdirSync(dirname(outputPath), { recursive: true });
  return openSync(outputPath, 'wx', 0o600);
}

function writeCommittedJson(fd, value) {
  writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fsyncSync(fd);
}

export async function runBoundNormalRssCapture(argv, env = process.env) {
  const config = parseArgs(argv);
  const preflight = validateEndpointEmbeddingEightPhysicalPreflightReport(
    await readRegularJsonFile(config.preflightReport),
  );
  endpointEmbeddingEightPhysicalPreflightIdentity(preflight);
  const preflightDigest = canonicalJsonSha256(preflight);

  let processFd = null;
  let boundFd = null;
  let processFdOpen = false;
  let boundFdOpen = false;
  let outputsCommitted = false;
  let snapshotDir = null;

  try {
    processFd = reserveExclusiveOutput(config.processRssOutputPath);
    processFdOpen = true;
    boundFd = reserveExclusiveOutput(config.boundOutputPath);
    boundFdOpen = true;

    snapshotDir = mkdtempSync(join(tmpdir(), 'unzen-normal-rss-preflight-'));
    const snapshotPath = join(snapshotDir, 'preflight.snapshot.json');
    const temporaryProcessRssPath = join(snapshotDir, 'process-rss.capture.json');
    writeFileSync(snapshotPath, `${JSON.stringify(preflight, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    chmodSync(snapshotPath, 0o400);

    const result = spawnSync(process.execPath, [
      CAPTURE_SCRIPT,
      config.dataDir,
      snapshotPath,
      config.graphPath,
      temporaryProcessRssPath,
    ], {
      env,
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    if (result.signal) throw new Error(`normal RSS capture terminated by signal ${result.signal}`);
    if (result.status !== 0) throw new Error(`normal RSS capture exited with status ${result.status}`);

    const snapshotAfter = validateEndpointEmbeddingEightPhysicalPreflightReport(
      await readRegularJsonFile(snapshotPath),
    );
    endpointEmbeddingEightPhysicalPreflightIdentity(snapshotAfter);
    if (canonicalJsonSha256(snapshotAfter) !== preflightDigest) {
      throw new Error('validated preflight snapshot changed during normal RSS capture');
    }

    const evidence = readStableProcessRssEvidence(temporaryProcessRssPath);
    const bound = buildBoundNormalRssEvidence(evidence, snapshotAfter);

    writeCommittedJson(processFd, evidence);
    writeCommittedJson(boundFd, bound);
    closeSync(processFd);
    processFdOpen = false;
    closeSync(boundFd);
    boundFdOpen = false;
    outputsCommitted = true;
    return bound;
  } finally {
    if (processFdOpen) closeSync(processFd);
    if (boundFdOpen) closeSync(boundFd);
    if (!outputsCommitted) {
      rmSync(config.processRssOutputPath, { force: true });
      rmSync(config.boundOutputPath, { force: true });
    }
    if (snapshotDir !== null) rmSync(snapshotDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runBoundNormalRssCapture(process.argv.slice(2)).then((report) => {
    process.stdout.write(`${JSON.stringify({
      status: report.status,
      manifestPayloadSetSha256: report.runtimeIdentity.manifestPayloadSetSha256,
      verifiedPhysicalArtifactCount: report.runtimeVerification.verifiedPhysicalArtifactCount,
      processRssEvidenceCanonicalSha256: report.sourceDocuments.processRssEvidenceCanonicalSha256,
      preflightReportCanonicalSha256: report.sourceDocuments.preflightReportCanonicalSha256,
    }, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
