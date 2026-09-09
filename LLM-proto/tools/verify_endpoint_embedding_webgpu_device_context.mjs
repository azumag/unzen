#!/usr/bin/env node
/** Verify browser/WebGPU device context preserved in captured endpoint embedding evidence. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCapturedEndpointEmbeddingRuntimeEvidence } from './capture_endpoint_embedding_webgpu_runtime.mjs';

const LIMIT_FIELDS = [
  'maxBufferSize',
  'maxStorageBufferBindingSize',
  'maxComputeWorkgroupStorageSize',
];

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requirePositiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function chromeMajorFromUserAgent(userAgent) {
  const match = userAgent.match(/(?:HeadlessChrome|Chrome)\/(\d+)\./);
  if (!match) throw new Error('userAgent must identify Chrome/HeadlessChrome with a major version');
  return Number(match[1]);
}

function chromeMajorFromCdpBrowser(cdpBrowser) {
  const match = cdpBrowser.match(/(?:HeadlessChrome|Chrome)\/(\d+)\./)
    ?? cdpBrowser.match(/\b(\d+)\.\d+\.\d+\.\d+\b/);
  if (!match) throw new Error('captureEnvironment.cdpBrowser must contain a Chrome major version');
  return Number(match[1]);
}

export function validateEndpointEmbeddingWebGpuDeviceContextFields(evidence) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    throw new Error('device-context evidence must be an object');
  }

  const userAgent = requireNonEmptyString(evidence.userAgent, 'userAgent');
  const cdpBrowser = requireNonEmptyString(
    evidence.captureEnvironment?.cdpBrowser,
    'captureEnvironment.cdpBrowser',
  );
  const userAgentMajor = chromeMajorFromUserAgent(userAgent);
  const cdpMajor = chromeMajorFromCdpBrowser(cdpBrowser);
  if (userAgentMajor !== cdpMajor) {
    throw new Error(`userAgent/CDP Chrome major mismatch: ${userAgentMajor} != ${cdpMajor}`);
  }

  const adapterInfo = evidence.adapterInfo;
  if (adapterInfo !== null) {
    if (!adapterInfo || typeof adapterInfo !== 'object' || Array.isArray(adapterInfo)) {
      throw new Error('adapterInfo must be null or an object');
    }
    for (const field of ['vendor', 'architecture', 'device', 'description']) {
      if (typeof adapterInfo[field] !== 'string') {
        throw new Error(`adapterInfo.${field} must be a string`);
      }
    }
  }

  const adapterLimits = evidence.adapterLimits;
  if (!adapterLimits || typeof adapterLimits !== 'object' || Array.isArray(adapterLimits)) {
    throw new Error('adapterLimits must be an object');
  }
  for (const field of LIMIT_FIELDS) {
    requirePositiveSafeInteger(adapterLimits[field], `adapterLimits.${field}`);
  }

  return evidence;
}

export function validateCapturedEndpointEmbeddingWebGpuDeviceContext(evidence) {
  validateCapturedEndpointEmbeddingRuntimeEvidence(evidence);
  validateEndpointEmbeddingWebGpuDeviceContextFields(evidence);
  return evidence;
}

export function verifyCapturedEndpointEmbeddingWebGpuDeviceContextFile(evidencePath) {
  const resolvedPath = resolve(evidencePath);
  const evidence = JSON.parse(readFileSync(resolvedPath, 'utf8'));
  validateCapturedEndpointEmbeddingWebGpuDeviceContext(evidence);
  return {
    status: evidence.status,
    decisionStatus: evidence.decisionStatus,
    evidenceLevel: evidence.evidenceLevel,
    userAgent: evidence.userAgent,
    adapterInfo: evidence.adapterInfo,
    adapterLimits: evidence.adapterLimits,
    captureEnvironment: evidence.captureEnvironment,
  };
}

function isMainModule() {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  const [evidencePath] = process.argv.slice(2);
  if (!evidencePath) {
    console.error('usage: verify_endpoint_embedding_webgpu_device_context.mjs EVIDENCE_JSON');
    process.exit(2);
  }
  try {
    console.log(JSON.stringify(verifyCapturedEndpointEmbeddingWebGpuDeviceContextFile(evidencePath), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
