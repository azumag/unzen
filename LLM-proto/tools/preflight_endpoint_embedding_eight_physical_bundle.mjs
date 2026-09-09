#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ENDPOINT_EMBEDDING_EIGHT_PHYSICAL_EXPECTED,
  buildEndpointEmbeddingEightPhysicalRuntimePlan,
} from '../browser-harness/endpoint-embedding-eight-physical-webgpu/contract.js';

export const ENDPOINT_EMBEDDING_EIGHT_PHYSICAL_PREFLIGHT = Object.freeze({
  kind: 'unzen-pinned-llama-1b-endpoint-embedding-eight-physical-bundle-preflight',
  schemaVersion: '1.0.0',
  hashBufferBytes: 1024 * 1024,
});

const CANONICAL_SHA256 = /^[0-9a-f]{64}$/;

function requireObject(value, field) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value;
}

function requireEqual(actual, expected, field) {
  if (actual !== expected) throw new Error(`${field} mismatch`);
}

function validateInspection(inspection, field) {
  const value = requireObject(inspection, field);
  if (typeof value.file !== 'string' || value.file.length === 0) {
    throw new Error(`${field}.file must be a non-empty string`);
  }
  if (!Number.isSafeInteger(value.bytes) || value.bytes < 0) {
    throw new Error(`${field}.bytes must be a non-negative safe integer`);
  }
  if (typeof value.sha256 !== 'string' || !CANONICAL_SHA256.test(value.sha256)) {
    throw new Error(`${field}.sha256 must be a canonical lowercase SHA-256`);
  }
  return value;
}

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

export function calculateEndpointEmbeddingPayloadSetSha256(artifacts) {
  if (!Array.isArray(artifacts)) throw new Error('manifest.physicalArtifacts must be an array');
  return createHash('sha256').update(canonicalJson(artifacts), 'utf8').digest('hex');
}

async function openRegularFileNoFollow(resolvedPath) {
  const pathStat = await lstat(resolvedPath);
  if (pathStat.isSymbolicLink()) throw new Error(`${resolvedPath} must not be a symbolic link`);
  if (!pathStat.isFile()) throw new Error(`${resolvedPath} must be a regular file`);

  const noFollow = constants.O_NOFOLLOW ?? 0;
  const handle = await open(resolvedPath, constants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error(`${resolvedPath} must remain a regular file`);
    return { handle, before };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export function evaluateEndpointEmbeddingEightPhysicalBundle(manifest, inspections) {
  const expected = ENDPOINT_EMBEDDING_EIGHT_PHYSICAL_EXPECTED;
  const runtimePlan = buildEndpointEmbeddingEightPhysicalRuntimePlan(manifest);
  requireEqual(
    manifest.payloadSetSha256,
    calculateEndpointEmbeddingPayloadSetSha256(manifest.physicalArtifacts),
    'manifest.payloadSetSha256',
  );

  const evidence = requireObject(inspections, 'inspections');
  const graph = validateInspection(evidence.graph, 'inspections.graph');
  requireEqual(graph.file, expected.graphFile, 'inspections.graph.file');
  requireEqual(graph.bytes, expected.graphBytes, 'inspections.graph.bytes');
  requireEqual(graph.sha256, expected.graphSha256, 'inspections.graph.sha256');

  if (!Array.isArray(evidence.payloads) || evidence.payloads.length !== runtimePlan.length) {
    throw new Error(`inspections.payloads must contain exactly ${runtimePlan.length} entries`);
  }

  const payloads = runtimePlan.map((entry, index) => {
    const actual = validateInspection(evidence.payloads[index], `inspections.payloads[${index}]`);
    requireEqual(actual.file, entry.payloadFile, `inspections.payloads[${index}].file`);
    requireEqual(actual.bytes, entry.expectedPayloadBytes, `inspections.payloads[${index}].bytes`);
    requireEqual(actual.sha256, entry.expectedPayloadSha256, `inspections.payloads[${index}].sha256`);
    return Object.freeze({
      index,
      file: actual.file,
      bytes: actual.bytes,
      sha256: actual.sha256,
      sourceOffsetBytes: entry.sourceOffsetBytes,
      sourceEndOffsetBytesExclusive: entry.sourceEndOffsetBytesExclusive,
    });
  });

  return Object.freeze({
    kind: ENDPOINT_EMBEDDING_EIGHT_PHYSICAL_PREFLIGHT.kind,
    schemaVersion: ENDPOINT_EMBEDDING_EIGHT_PHYSICAL_PREFLIGHT.schemaVersion,
    status: 'pass',
    decisionStatus: 'diagnostic-only',
    selectedPhysicalArtifactCount: null,
    candidatePhysicalArtifactCount: expected.candidatePhysicalArtifactCount,
    sourceGraphSha256: expected.sourceGraphSha256,
    sourceExternalData: { ...expected.sourceExternalData },
    manifestPayloadSetSha256: manifest.payloadSetSha256,
    graph: Object.freeze({ ...graph }),
    payloads: Object.freeze(payloads),
    runtimePlan: Object.freeze(runtimePlan),
    evidenceBoundary: 'actual-file-integrity-preflight-only',
    conclusion: (
      'Verified the actual reused embedding graph and all eight generated payload files against the '
      + 'diagnostic runtime plan. This does not establish Chrome/ORT WebGPU range supply or select '
      + 'the 8-physical architecture.'
    ),
  });
}

export async function inspectRegularFile(filePath) {
  const resolvedPath = resolve(filePath);
  const { handle, before } = await openRegularFileNoFollow(resolvedPath);
  try {
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(ENDPOINT_EMBEDDING_EIGHT_PHYSICAL_PREFLIGHT.hashBufferBytes);
    let totalBytes = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      totalBytes += bytesRead;
    }

    const after = await handle.stat();
    if (after.size !== before.size || totalBytes !== before.size) {
      throw new Error(`${resolvedPath} changed while hashing`);
    }
    return Object.freeze({
      file: basename(resolvedPath),
      bytes: totalBytes,
      sha256: hash.digest('hex'),
    });
  } finally {
    await handle.close();
  }
}

export async function readRegularJsonFile(filePath) {
  const resolvedPath = resolve(filePath);
  const { handle, before } = await openRegularFileNoFollow(resolvedPath);
  try {
    const text = await handle.readFile({ encoding: 'utf8' });
    const after = await handle.stat();
    if (after.size !== before.size || Buffer.byteLength(text, 'utf8') !== before.size) {
      throw new Error(`${resolvedPath} changed while reading`);
    }
    return JSON.parse(text);
  } finally {
    await handle.close();
  }
}

export async function assertNonSymlinkDirectory(directoryPath) {
  const resolvedPath = resolve(directoryPath);
  const pathStat = await lstat(resolvedPath);
  if (pathStat.isSymbolicLink()) throw new Error(`${resolvedPath} must not be a symbolic link`);
  if (!pathStat.isDirectory()) throw new Error(`${resolvedPath} must be a directory`);
  return resolvedPath;
}

export async function preflightEndpointEmbeddingEightPhysicalBundle({ manifestPath, graphPath, payloadDir }) {
  const resolvedManifest = resolve(manifestPath);
  const resolvedGraph = resolve(graphPath);
  const resolvedPayloadDir = await assertNonSymlinkDirectory(payloadDir);
  const manifest = await readRegularJsonFile(resolvedManifest);
  const runtimePlan = buildEndpointEmbeddingEightPhysicalRuntimePlan(manifest);

  const graph = await inspectRegularFile(resolvedGraph);
  const payloads = [];
  for (const entry of runtimePlan) {
    payloads.push(await inspectRegularFile(resolve(resolvedPayloadDir, entry.payloadFile)));
  }
  return evaluateEndpointEmbeddingEightPhysicalBundle(manifest, { graph, payloads });
}

export function parseEndpointEmbeddingEightPhysicalPreflightArgs(argv) {
  if (!Array.isArray(argv) || argv.length !== 3 || argv.some((value) => !value)) {
    throw new Error(
      'usage: preflight_endpoint_embedding_eight_physical_bundle.mjs '
      + '<manifest.json> <embedding-offset-0.onnx> <payload-dir>',
    );
  }
  return {
    manifestPath: argv[0],
    graphPath: argv[1],
    payloadDir: argv[2],
  };
}

async function main() {
  const args = parseEndpointEmbeddingEightPhysicalPreflightArgs(process.argv.slice(2));
  const report = await preflightEndpointEmbeddingEightPhysicalBundle(args);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
