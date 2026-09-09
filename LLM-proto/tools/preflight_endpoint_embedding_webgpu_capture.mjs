#!/usr/bin/env node
/** Preflight the pinned endpoint embedding ORT Web/WebGPU capture inputs. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, lstatSync, readFileSync } from 'node:fs';
import { platform } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ENDPOINT_EMBEDDING_WEBGPU_EXPECTED,
  validateEndpointEmbeddingWebGpuManifest,
} from '../browser-harness/endpoint-embedding-tiled-webgpu/contract.js';
import { probeEndpointEmbeddingWebGpuHost } from './probe_endpoint_embedding_webgpu_host.mjs';

const EXPECTED = ENDPOINT_EMBEDDING_WEBGPU_EXPECTED;

function snapshotIdentity(stat) {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
}

function sameIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function requireRegularFile(path, label) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symlink`);
  if (!stat.isFile()) throw new Error(`${label} must be a regular file`);
  return stat;
}

function requireDataDirectory(path) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error('capture data directory must not be a symlink');
  if (!stat.isDirectory()) throw new Error('capture data directory must be a directory');
  return stat;
}

async function sha256File(path) {
  const digest = createHash('sha256');
  await new Promise((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => digest.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolvePromise);
  });
  return digest.digest('hex');
}

export async function verifyPreparedFileIdentity(path, expected, label = basename(path)) {
  if (!expected || !Number.isSafeInteger(expected.bytes) || expected.bytes < 0) {
    throw new Error(`${label} expected byte length is invalid`);
  }
  if (typeof expected.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(expected.sha256)) {
    throw new Error(`${label} expected SHA-256 is invalid`);
  }

  const beforeStat = requireRegularFile(path, label);
  const before = snapshotIdentity(beforeStat);
  if (before.size !== expected.bytes) {
    throw new Error(`${label} byte length mismatch: expected ${expected.bytes}, got ${before.size}`);
  }

  const sha256 = await sha256File(path);
  const afterStat = requireRegularFile(path, label);
  const after = snapshotIdentity(afterStat);
  if (!sameIdentity(before, after)) throw new Error(`${label} changed while hashing`);
  if (sha256 !== expected.sha256) {
    throw new Error(`${label} SHA-256 mismatch: expected ${expected.sha256}, got ${sha256}`);
  }

  return {
    fileName: basename(path),
    bytes: before.size,
    sha256,
  };
}

export function parseChromeVersion(versionOutput) {
  if (typeof versionOutput !== 'string' || versionOutput.trim().length === 0) {
    throw new Error('Chrome version output must be a non-empty string');
  }
  const match = versionOutput.match(/\d+\.\d+\.\d+\.\d+/);
  if (!match) throw new Error(`Chrome version output does not contain a four-part version: ${versionOutput.trim()}`);
  return {
    raw: versionOutput.trim(),
    version: match[0],
  };
}

export function validateChromeHostProbeIdentity(chrome, hostProbe) {
  if (!chrome || typeof chrome !== 'object' || Array.isArray(chrome)) {
    throw new Error('Chrome executable identity must be an object');
  }
  if (typeof chrome.version !== 'string' || !/^\d+\.\d+\.\d+\.\d+$/.test(chrome.version)) {
    throw new Error('Chrome executable identity must contain a four-part version');
  }
  if (!hostProbe || typeof hostProbe !== 'object' || Array.isArray(hostProbe)) {
    throw new Error('WebGPU host probe identity must be an object');
  }
  if (typeof hostProbe.userAgent !== 'string' || hostProbe.userAgent.trim().length === 0) {
    throw new Error('WebGPU host probe userAgent must be a non-empty string');
  }
  const userAgentMatch = hostProbe.userAgent.match(/(?:HeadlessChrome|Chrome)\/(\d+)\./);
  if (!userAgentMatch) {
    throw new Error('WebGPU host probe userAgent must identify Chrome/HeadlessChrome with a major version');
  }

  const executableMajor = Number(chrome.version.split('.')[0]);
  const hostProbeMajor = Number(userAgentMatch[1]);
  if (!Number.isSafeInteger(executableMajor) || !Number.isSafeInteger(hostProbeMajor)) {
    throw new Error('Chrome executable/host-probe major version is invalid');
  }
  if (executableMajor !== hostProbeMajor) {
    throw new Error(`Chrome executable/host-probe major mismatch: ${executableMajor} != ${hostProbeMajor}`);
  }
  return hostProbe;
}

export function defaultChromeBinary() {
  if (process.env.CHROME_BINARY) return process.env.CHROME_BINARY;
  if (platform() === 'darwin') return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  return 'google-chrome';
}

export function probeChromeVersion(chromeBinary = defaultChromeBinary()) {
  const output = execFileSync(chromeBinary, ['--version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return parseChromeVersion(output);
}

function readPinnedManifest(dataDir) {
  const manifestPath = join(dataDir, 'manifest.json');
  const beforeStat = requireRegularFile(manifestPath, 'manifest.json');
  const before = snapshotIdentity(beforeStat);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const afterStat = requireRegularFile(manifestPath, 'manifest.json');
  const after = snapshotIdentity(afterStat);
  if (!sameIdentity(before, after)) throw new Error('manifest.json changed while reading');
  validateEndpointEmbeddingWebGpuManifest(manifest);
  return manifest;
}

export async function preflightEndpointEmbeddingWebGpuCapture({ dataDir, chromeBinary = defaultChromeBinary() }) {
  const resolvedDataDir = resolve(dataDir);
  requireDataDirectory(resolvedDataDir);
  const manifest = readPinnedManifest(resolvedDataDir);

  // Fail fast on browser/WebGPU host capability before streaming the ~1 GiB prepared payload set.
  const chrome = probeChromeVersion(chromeBinary);
  const hostProbe = await probeEndpointEmbeddingWebGpuHost({ chromeBinary });
  validateChromeHostProbeIdentity(chrome, hostProbe);

  const verifiedFiles = [];
  for (const [variantName, variant] of Object.entries(EXPECTED.graphVariants)) {
    verifiedFiles.push({
      role: `graph:${variantName}`,
      ...await verifyPreparedFileIdentity(
        join(resolvedDataDir, variant.file),
        { bytes: variant.bytes, sha256: variant.sha256 },
        `graph variant ${variantName}`,
      ),
    });
  }

  for (const artifact of EXPECTED.physicalArtifacts) {
    verifiedFiles.push({
      role: `physical-artifact:${artifact.index}`,
      ...await verifyPreparedFileIdentity(
        join(resolvedDataDir, artifact.file),
        { bytes: artifact.bytes, sha256: artifact.sha256 },
        `physical artifact ${artifact.index}`,
      ),
    });
  }

  return {
    status: 'pass',
    decisionStatus: 'diagnostic-only',
    kind: 'unzen-endpoint-embedding-webgpu-capture-preflight',
    schemaVersion: '1.0.0',
    dataDir: resolvedDataDir,
    manifest: {
      kind: manifest.kind,
      schemaVersion: manifest.schemaVersion,
      sourceGraphSha256: manifest.sourceGraphSha256,
      sourceExternalData: manifest.sourceExternalData,
      physicalArtifactCount: manifest.physicalArtifactCount,
      executionTileCount: manifest.executionTileCount,
    },
    chrome,
    hostProbe,
    verifiedFiles,
    verifiedFileCount: verifiedFiles.length,
    verifiedBytes: verifiedFiles.reduce((sum, file) => sum + file.bytes, 0),
    conclusion: 'The prepared endpoint embedding browser bundle, Chrome executable, and a lightweight loopback WebGPU adapter/device probe satisfy the pinned diagnostic capture preflight. The host-probe Chrome major is bound to the selected executable identity. This does not constitute browser/WebGPU execution evidence or ORT WebGPU inference evidence.',
  };
}

function main(argv) {
  if (argv.length < 1 || argv.length > 2) {
    throw new Error('usage: preflight_endpoint_embedding_webgpu_capture.mjs DATA_DIR [CHROME_BINARY]');
  }
  const [dataDir, chromeBinary = defaultChromeBinary()] = argv;
  return preflightEndpointEmbeddingWebGpuCapture({ dataDir, chromeBinary });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
    .then((report) => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
