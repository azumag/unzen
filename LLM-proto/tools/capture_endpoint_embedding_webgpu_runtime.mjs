#!/usr/bin/env node
/** Capture the diagnostic-only endpoint embedding ORT Web/WebGPU runtime report. */
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { platform, tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENDPOINT_EMBEDDING_WEBGPU_EXPECTED } from '../browser-harness/endpoint-embedding-tiled-webgpu/contract.js';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, '..');
const HARNESS = resolve(ROOT, 'browser-harness/endpoint-embedding-tiled-webgpu/serve.mjs');
const EXPECTED = ENDPOINT_EMBEDDING_WEBGPU_EXPECTED;
const DEFAULT_TIMEOUT_MS = 120000;
const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
const exact = (left, right) => JSON.stringify(left) === JSON.stringify(right);

export function validateEndpointEmbeddingRuntimeReport(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) throw new Error('runtime report must be an object');
  if (report.schemaVersion !== EXPECTED.schemaVersion) throw new Error('runtime report schemaVersion drift');
  if (report.kind !== EXPECTED.runtimeReportKind) throw new Error('runtime report kind drift');
  if (report.status !== 'pass') throw new Error(`runtime report did not pass: ${report.error ?? 'unknown failure'}`);
  if (report.decisionStatus !== 'diagnostic-only') throw new Error('runtime report must remain diagnostic-only');
  if (report.evidenceLevel !== 'self-reported-runtime') throw new Error('runtime report evidence level drift');
  if (report.onnxruntimeWebVersion !== EXPECTED.onnxruntimeWebVersion) throw new Error('ORT Web version drift');
  if (report.sourceGraphSha256 !== EXPECTED.sourceGraphSha256) throw new Error('source graph identity drift');
  if (!exact(report.sourceExternalData, EXPECTED.sourceExternalData)) throw new Error('source external-data identity drift');
  if (!exact(report.embeddingInitializer, EXPECTED.embeddingInitializer)) throw new Error('embedding initializer drift');
  if (!exact(report.tokenIds, EXPECTED.tokenIds)) throw new Error('token routing drift');
  if (!exact(report.sequentialExecution, EXPECTED.sequentialExecution)) throw new Error('sequential execution contract drift');
  const expectedVerified = EXPECTED.physicalArtifacts.map(({ index, bytes, sha256 }) => ({ index, bytes, sha256 }));
  if (!exact(report.verifiedPhysicalArtifacts, expectedVerified)) throw new Error('physical artifact identity/coverage drift');
  if (!Array.isArray(report.executedTiles) || report.executedTiles.length !== EXPECTED.executionTileCount) throw new Error('tile coverage drift');
  for (let i = 0; i < EXPECTED.executionTileCount; i += 1) {
    const tile = report.executedTiles[i];
    const expectedTile = EXPECTED.tiles[i];
    for (const field of ['tileIndex', 'startRow', 'endRowExclusive', 'physicalArtifactIndex', 'artifactByteOffset', 'byteLength', 'graphVariant']) {
      if (tile?.[field] !== expectedTile[field]) throw new Error(`tile ${i} ${field} drift`);
    }
    for (const field of ['positions', 'globalTokenIds', 'localTokenIds']) {
      if (!exact(tile?.[field], expectedTile[field])) throw new Error(`tile ${i} ${field} drift`);
    }
    if (tile?.comparison?.exactEqual !== true || tile?.comparison?.maxAbsDiff !== 0) throw new Error(`tile ${i} numerical mismatch`);
    if (!(tile?.sessionCreateMs >= 0) || !(tile?.runMs >= 0) || !(tile?.sessionReleaseMs >= 0)) throw new Error(`tile ${i} timing/release evidence missing`);
  }
  if (report.completeEmbeddingComparison?.exactEqual !== true || report.completeEmbeddingComparison?.maxAbsDiff !== 0) throw new Error('complete embedding comparison mismatch');
  if (!exact(report.outputShape, [EXPECTED.tokenIds.length, EXPECTED.hiddenSize])) throw new Error('output shape drift');
  if (report.sessionReleaseApiCompleted !== true) throw new Error('session release API evidence missing');
  return report;
}

class CdpClient {
  constructor(url) { this.url = url; this.socket = null; this.nextId = 1; this.pending = new Map(); }
  async connect() {
    await new Promise((resolvePromise, reject) => {
      const socket = new WebSocket(this.url); this.socket = socket;
      socket.addEventListener('open', resolvePromise);
      socket.addEventListener('error', () => reject(new Error('CDP websocket connection failed')));
      socket.addEventListener('message', (event) => {
        const message = JSON.parse(String(event.data));
        if (!message.id) return;
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message ?? 'CDP command failed'));
        else pending.resolve(message.result ?? {});
      });
      socket.addEventListener('close', () => {
        for (const pending of this.pending.values()) pending.reject(new Error('CDP websocket closed'));
        this.pending.clear();
      });
    });
  }
  send(method, params = {}) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error('CDP websocket is not open');
    const id = this.nextId++;
    return new Promise((resolvePromise, reject) => {
      this.pending.set(id, { resolve: resolvePromise, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { this.socket?.close(); }
}

async function assertPortAvailable(port, label) {
  await new Promise((resolvePromise, reject) => {
    const server = createNetServer();
    server.once('error', (error) => reject(new Error(`${label} port ${port} unavailable: ${error.message}`)));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => server.close((error) => error ? reject(error) : resolvePromise()));
  });
}

async function waitFor(url, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { cache: 'no-store' });
      if (response.ok) return response;
    } catch (error) { lastError = error; }
    await sleep(100);
  }
  throw new Error(`${label} did not become ready${lastError ? `: ${lastError}` : ''}`);
}

function chromeDefault() {
  if (process.env.CHROME_BINARY) return process.env.CHROME_BINARY;
  if (platform() === 'darwin') return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  return 'google-chrome';
}

async function runCapture({ dataDir, outputPath, chromeBinary, serverPort, debugPort, timeoutMs }) {
  mkdirSync(dirname(outputPath), { recursive: true });
  await assertPortAvailable(serverPort, 'harness');
  await assertPortAvailable(debugPort, 'DevTools');
  const profileDir = mkdtempSync(join(tmpdir(), 'unzen-endpoint-embedding-webgpu-'));
  let server;
  let chrome;
  let cdp;
  try {
    server = spawn(process.execPath, [HARNESS], { cwd: ROOT, env: { ...process.env, DATA_DIR: dataDir, PORT: String(serverPort) }, stdio: 'ignore' });
    const harnessUrl = `http://127.0.0.1:${serverPort}/`;
    const response = await waitFor(harnessUrl, 10000, 'harness');
    if (server.exitCode !== null) throw new Error(`harness server exited early with ${server.exitCode}`);
    const html = await response.text();
    if (!html.includes('Unzen endpoint embedding tiled ORT WebGPU diagnostic')) throw new Error('harness identity check failed');

    chrome = spawn(chromeBinary, ['--headless=new', `--user-data-dir=${profileDir}`, '--disable-gpu-sandbox', '--enable-unsafe-webgpu', '--no-first-run', '--no-default-browser-check', `--remote-debugging-port=${debugPort}`, 'about:blank'], { stdio: 'ignore' });
    const version = await (await waitFor(`http://127.0.0.1:${debugPort}/json/version`, 10000, 'Chrome DevTools')).json();
    if (chrome.exitCode !== null) throw new Error(`Chrome exited early with ${chrome.exitCode}`);
    const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
    const page = targets.find((target) => target.type === 'page' && target.url === 'about:blank');
    if (!page?.webSocketDebuggerUrl) throw new Error('CDP page target unavailable');
    cdp = new CdpClient(page.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Page.navigate', { url: harnessUrl });

    const deadline = Date.now() + timeoutMs;
    let report = null;
    while (Date.now() < deadline) {
      try {
        const result = await cdp.send('Runtime.evaluate', { expression: 'JSON.stringify(window.__unzenEndpointEmbeddingWebGpuReport ?? null)', returnByValue: true });
        const raw = result?.result?.value;
        if (typeof raw === 'string') report = JSON.parse(raw);
        if (report?.status === 'fail') throw new Error(`browser harness failed: ${report.error ?? 'unknown failure'}`);
        if (report?.status === 'pass') break;
      } catch (error) {
        if (String(error).includes('browser harness failed')) throw error;
      }
      await sleep(100);
    }
    validateEndpointEmbeddingRuntimeReport(report);
    const evidence = {
      ...report,
      evidenceLevel: 'captured-browser-runtime',
      capturedAtUtc: new Date().toISOString(),
      captureEnvironment: {
        chromeVersion: execFileSync(chromeBinary, ['--version'], { encoding: 'utf8' }).trim(),
        cdpBrowser: version.Browser,
        nodeVersion: process.version,
        platform: platform(),
      },
    };
    writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' });
    return evidence;
  } finally {
    cdp?.close();
    if (chrome?.pid) { try { process.kill(chrome.pid, 'SIGTERM'); } catch {} }
    if (server?.pid) { try { process.kill(server.pid, 'SIGTERM'); } catch {} }
    rmSync(profileDir, { recursive: true, force: true });
  }
}

function parseBoundedInt(value, label, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${label} must be an integer in [${minimum}, ${maximum}]`);
  return parsed;
}

function parseArgs(argv) {
  if (argv.length < 2 || argv.length > 6) throw new Error('usage: capture_endpoint_embedding_webgpu_runtime.mjs DATA_DIR OUTPUT_JSON [SERVER_PORT] [DEBUG_PORT] [TIMEOUT_MS] [CHROME_BINARY]');
  const [dataDir, outputPath, serverPort = '8796', debugPort = '9228', timeoutMs = String(DEFAULT_TIMEOUT_MS), chromeBinary = chromeDefault()] = argv;
  return {
    dataDir: resolve(dataDir),
    outputPath: resolve(outputPath),
    serverPort: parseBoundedInt(serverPort, 'server port', 1, 65535),
    debugPort: parseBoundedInt(debugPort, 'debug port', 1, 65535),
    timeoutMs: parseBoundedInt(timeoutMs, 'timeout', 1000, 30 * 60 * 1000),
    chromeBinary,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCapture(parseArgs(process.argv.slice(2))).then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
}
