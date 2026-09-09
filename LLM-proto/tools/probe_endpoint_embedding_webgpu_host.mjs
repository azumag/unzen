#!/usr/bin/env node
/** Probe a Chrome host for the lightweight WebGPU capability required by endpoint embedding capture. */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_TIMEOUT_MS = 15000;
const LIMIT_FIELDS = [
  'maxBufferSize',
  'maxStorageBufferBindingSize',
  'maxComputeWorkgroupStorageSize',
];

export function createEndpointEmbeddingWebGpuHostProbeChallenge() {
  const token = randomBytes(32).toString('hex');
  return {
    probePath: `/probe/${token}`,
    resultPath: `/result/${token}`,
  };
}

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

function validateLimits(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  for (const field of LIMIT_FIELDS) {
    requirePositiveSafeInteger(value[field], `${label}.${field}`);
  }
}

export function validateEndpointEmbeddingWebGpuHostProbeResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('WebGPU host probe result must be an object');
  }
  if (result.status !== 'pass') {
    throw new Error(`WebGPU host probe failed: ${result.error ?? 'unknown failure'}`);
  }
  if (result.secureContext !== true) throw new Error('WebGPU host probe requires a secure context');
  requireNonEmptyString(result.userAgent, 'WebGPU host probe userAgent');
  if (!/(?:HeadlessChrome|Chrome)\/\d+\./.test(result.userAgent)) {
    throw new Error('WebGPU host probe userAgent must identify Chrome/HeadlessChrome');
  }

  if (result.adapterInfo !== null) {
    if (!result.adapterInfo || typeof result.adapterInfo !== 'object' || Array.isArray(result.adapterInfo)) {
      throw new Error('WebGPU host probe adapterInfo must be null or an object');
    }
    for (const field of ['vendor', 'architecture', 'device', 'description']) {
      if (typeof result.adapterInfo[field] !== 'string') {
        throw new Error(`WebGPU host probe adapterInfo.${field} must be a string`);
      }
    }
  }

  validateLimits(result.adapterLimits, 'WebGPU host probe adapterLimits');
  validateLimits(result.deviceLimits, 'WebGPU host probe deviceLimits');
  for (const field of LIMIT_FIELDS) {
    if (result.deviceLimits[field] > result.adapterLimits[field]) {
      throw new Error(`WebGPU host probe deviceLimits.${field} exceeds adapter limit`);
    }
  }
  if (result.deviceCreated !== true) throw new Error('WebGPU host probe device creation evidence missing');
  if (result.deviceDestroyed !== true) throw new Error('WebGPU host probe device destruction evidence missing');
  return result;
}

function probeHtml(resultPath) {
  const resultPathLiteral = JSON.stringify(resultPath);
  return `<!doctype html><meta charset="utf-8"><title>Unzen WebGPU host probe</title><script>
(async () => {
  const limits = (value) => ({
    maxBufferSize: Number(value.maxBufferSize),
    maxStorageBufferBindingSize: Number(value.maxStorageBufferBindingSize),
    maxComputeWorkgroupStorageSize: Number(value.maxComputeWorkgroupStorageSize),
  });
  let device;
  let deviceDestroyed = false;
  let result;
  try {
    if (!window.isSecureContext) throw new Error('secure context unavailable');
    if (!navigator.gpu) throw new Error('WebGPU unavailable');
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('WebGPU adapter unavailable');
    const info = adapter.info;
    const adapterInfo = info ? {
      vendor: String(info.vendor ?? ''),
      architecture: String(info.architecture ?? ''),
      device: String(info.device ?? ''),
      description: String(info.description ?? ''),
    } : null;
    device = await adapter.requestDevice();
    if (!device) throw new Error('WebGPU device unavailable');
    const deviceLimits = limits(device.limits);
    device.destroy();
    deviceDestroyed = true;
    result = {
      status: 'pass',
      secureContext: window.isSecureContext,
      userAgent: navigator.userAgent,
      adapterInfo,
      adapterLimits: limits(adapter.limits),
      deviceLimits,
      deviceCreated: true,
      deviceDestroyed,
    };
  } catch (error) {
    try {
      if (device && !deviceDestroyed) {
        device.destroy();
        deviceDestroyed = true;
      }
    } catch {}
    result = {
      status: 'fail',
      error: error instanceof Error ? error.message : String(error),
      secureContext: window.isSecureContext,
      userAgent: navigator.userAgent,
      deviceCreated: Boolean(device),
      deviceDestroyed,
    };
  }
  try {
    await fetch(${resultPathLiteral}, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(result),
    });
  } catch {}
})();
</script>`;
}

function listen(server) {
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      server.removeListener('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('WebGPU host probe server address unavailable'));
        return;
      }
      resolvePromise(address.port);
    });
  });
}

function closeServer(server) {
  return new Promise((resolvePromise) => {
    if (!server.listening) {
      resolvePromise();
      return;
    }
    server.close(() => resolvePromise());
  });
}

export async function probeEndpointEmbeddingWebGpuHost({ chromeBinary, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  requireNonEmptyString(chromeBinary, 'Chrome binary');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) {
    throw new Error('WebGPU host probe timeout must be an integer in [1000, 60000]');
  }

  const { probePath, resultPath } = createEndpointEmbeddingWebGpuHostProbeChallenge();
  let resolveResult;
  let rejectResult;
  let settled = false;
  let bodyBytes = 0;
  const resultPromise = new Promise((resolvePromise, reject) => {
    resolveResult = resolvePromise;
    rejectResult = reject;
  });
  const settleResolve = (value) => {
    if (settled) return;
    settled = true;
    resolveResult(value);
  };
  const settleReject = (error) => {
    if (settled) return;
    settled = true;
    rejectResult(error);
  };

  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === probePath) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(probeHtml(resultPath));
      return;
    }
    if (request.method === 'POST' && request.url === resultPath) {
      const chunks = [];
      request.on('data', (chunk) => {
        bodyBytes += chunk.length;
        if (bodyBytes > 65536) request.destroy(new Error('WebGPU host probe result exceeds 64 KiB'));
        else chunks.push(chunk);
      });
      request.on('error', settleReject);
      request.on('end', () => {
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          response.writeHead(204, { 'cache-control': 'no-store' });
          response.end();
          settleResolve(result);
        } catch (error) {
          response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
          response.end('invalid result');
          settleReject(error);
        }
      });
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('not found');
  });

  let chrome;
  let timeout;
  let profileDir;
  let stderr = '';
  try {
    const port = await listen(server);
    profileDir = mkdtempSync(join(tmpdir(), 'unzen-endpoint-embedding-webgpu-host-probe-'));
    const url = `http://127.0.0.1:${port}${probePath}`;
    chrome = spawn(chromeBinary, [
      '--headless=new',
      `--user-data-dir=${profileDir}`,
      '--disable-gpu-sandbox',
      '--enable-unsafe-webgpu',
      '--no-first-run',
      '--no-default-browser-check',
      url,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    chrome.stderr?.setEncoding('utf8');
    chrome.stderr?.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-8192);
    });
    chrome.once('error', (error) => settleReject(new Error(`Chrome WebGPU host probe failed to launch: ${error.message}`)));
    chrome.once('exit', (code, signal) => {
      if (!settled) {
        const detail = stderr.trim();
        settleReject(new Error(`Chrome WebGPU host probe exited before reporting (code=${code}, signal=${signal})${detail ? `: ${detail}` : ''}`));
      }
    });
    timeout = setTimeout(() => {
      settleReject(new Error(`Chrome WebGPU host probe timed out after ${timeoutMs} ms`));
    }, timeoutMs);

    const result = await resultPromise;
    validateEndpointEmbeddingWebGpuHostProbeResult(result);
    return {
      status: 'pass',
      decisionStatus: 'diagnostic-only',
      kind: 'unzen-endpoint-embedding-webgpu-host-probe',
      schemaVersion: '1.0.0',
      secureContext: result.secureContext,
      userAgent: result.userAgent,
      adapterInfo: result.adapterInfo,
      adapterLimits: result.adapterLimits,
      deviceLimits: result.deviceLimits,
      deviceCreated: result.deviceCreated,
      deviceDestroyed: result.deviceDestroyed,
      conclusion: 'Chrome created and destroyed a WebGPU device on a loopback secure context with the same headless/WebGPU flags used by the diagnostic capture. The probe page/result routes are bound to one random per-run challenge to avoid cross-run or unrelated loopback submissions. This is host-capability readiness evidence only, not ORT WebGPU inference evidence.',
    };
  } finally {
    if (timeout) clearTimeout(timeout);
    if (chrome?.pid) {
      try { process.kill(chrome.pid, 'SIGTERM'); } catch {}
    }
    await closeServer(server);
    if (profileDir) rmSync(profileDir, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  if (argv.length < 1 || argv.length > 2) {
    throw new Error('usage: probe_endpoint_embedding_webgpu_host.mjs CHROME_BINARY [TIMEOUT_MS]');
  }
  const [chromeBinary, timeoutRaw = String(DEFAULT_TIMEOUT_MS)] = argv;
  const timeoutMs = Number(timeoutRaw);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) {
    throw new Error('timeout must be an integer in [1000, 60000]');
  }
  return { chromeBinary, timeoutMs };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  probeEndpointEmbeddingWebGpuHost(parseArgs(process.argv.slice(2)))
    .then((report) => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
