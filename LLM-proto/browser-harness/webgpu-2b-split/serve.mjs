/**
 * Local Coordinator + static server for issue #165 real two-browser split PoC.
 *
 * The server is intentionally simple: browsers never contact each other.
 * Segment 0 uploads the measured boundary tensors to this Coordinator, and
 * segment 1 (or a standby segment-1 browser) retrieves them from here.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const DEFAULT_PORT = Number(process.env.PORT ?? 8791);
const MODELS_DIR = process.env.MODELS_DIR ? resolve(process.env.MODELS_DIR) : undefined;
const MAX_JSON_BYTES = 16 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.onnx': 'application/octet-stream',
  '.bin': 'application/octet-stream',
  '.data': 'application/octet-stream',
  '.wasm': 'application/wasm',
};

export function createCoordinatorState() {
  return {
    workers: new Map(),
    checkpoints: new Map(),
    results: new Map(),
  };
}

function json(res, status, value) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(value));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_JSON_BYTES) {
      throw new Error(`request body exceeds ${MAX_JSON_BYTES} bytes`);
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function safeRunId(raw) {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(raw)) throw new Error('invalid run id');
  return raw;
}

function safeWorkerId(raw) {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(raw)) throw new Error('invalid worker id');
  return raw;
}

async function statSafe(path) {
  try {
    return await stat(path);
  } catch {
    return undefined;
  }
}

async function serveFile(urlPath, res) {
  let base = ROOT;
  let pathname = urlPath;
  if (pathname === '/') pathname = '/index.html';
  if (pathname.startsWith('/models/')) {
    if (!MODELS_DIR) {
      res.writeHead(404).end('MODELS_DIR is not configured');
      return;
    }
    base = MODELS_DIR;
    pathname = pathname.slice('/models/'.length);
  }

  const target = normalize(join(base, pathname));
  const resolvedBase = resolve(base);
  const resolvedTarget = resolve(target);
  if (!(resolvedTarget === resolvedBase || resolvedTarget.startsWith(resolvedBase + '/'))) {
    res.writeHead(403).end('forbidden');
    return;
  }
  let file = resolvedTarget;
  if ((await statSafe(file))?.isDirectory()) file = join(file, 'index.html');
  const body = await readFile(file);
  res.writeHead(200, {
    'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
    'Cache-Control': pathname.startsWith('/models/') ? 'public, max-age=3600' : 'no-store',
  });
  res.end(body);
}

export function createSplitHarnessServer({ state = createCoordinatorState() } = {}) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      if (req.method === 'GET' && url.pathname === '/api/health') {
        json(res, 200, {
          ok: true,
          workers: state.workers.size,
          checkpoints: state.checkpoints.size,
          results: state.results.size,
          directWorkerNetworking: false,
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/workers/register') {
        const body = await readJson(req);
        const workerId = safeWorkerId(String(body.workerId ?? ''));
        const role = String(body.role ?? '');
        if (!['segment0', 'segment1', 'standby'].includes(role)) {
          json(res, 400, { ok: false, error: 'invalid worker role' });
          return;
        }
        state.workers.set(workerId, {
          workerId,
          role,
          registeredAt: Date.now(),
          adapter: body.adapter ?? null,
        });
        json(res, 201, { ok: true, workerId, role });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/workers') {
        json(res, 200, { workers: [...state.workers.values()] });
        return;
      }

      const checkpointMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/checkpoint$/);
      if (checkpointMatch) {
        const runId = safeRunId(checkpointMatch[1]);
        if (req.method === 'POST') {
          const body = await readJson(req);
          if (!Array.isArray(body.tensors) || body.tensors.length !== 2) {
            json(res, 400, { ok: false, error: 'exactly two boundary tensors are required' });
            return;
          }
          const record = {
            ...body,
            runId,
            relayOwner: 'coordinator',
            directWorkerNetworking: false,
            storedAt: Date.now(),
          };
          state.checkpoints.set(runId, record);
          json(res, 201, {
            ok: true,
            runId,
            relayOwner: 'coordinator',
            tensorBytes: body.tensors.reduce((sum, tensor) => sum + Number(tensor.bytes ?? 0), 0),
          });
          return;
        }
        if (req.method === 'GET') {
          const record = state.checkpoints.get(runId);
          if (!record) {
            json(res, 404, { ok: false, error: 'checkpoint-not-ready' });
            return;
          }
          json(res, 200, record);
          return;
        }
      }

      const resultMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/result$/);
      if (resultMatch) {
        const runId = safeRunId(resultMatch[1]);
        if (req.method === 'POST') {
          const body = await readJson(req);
          const record = { ...body, runId, storedAt: Date.now() };
          state.results.set(runId, record);
          json(res, 201, { ok: true, runId });
          return;
        }
        if (req.method === 'GET') {
          const record = state.results.get(runId);
          if (!record) {
            json(res, 404, { ok: false, error: 'result-not-ready' });
            return;
          }
          json(res, 200, record);
          return;
        }
      }

      if (url.pathname === '/worker-peer/direct') {
        json(res, 403, {
          ok: false,
          rejected: true,
          reason: 'direct worker-to-worker networking is forbidden; relay through Coordinator',
        });
        return;
      }

      if (req.method === 'GET' || req.method === 'HEAD') {
        await serveFile(url.pathname, res);
        return;
      }
      res.writeHead(404).end('not found');
    } catch (error) {
      json(res, 400, { ok: false, error: String(error?.message ?? error) });
    }
  });
  return { server, state };
}

export async function listenSplitHarness({ port = DEFAULT_PORT } = {}) {
  const { server, state } = createSplitHarnessServer();
  await new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(port, '127.0.0.1', resolvePromise);
  });
  return { server, state, port };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  listenSplitHarness().then(({ port }) => {
    console.log(`Unzen real two-browser split harness: http://127.0.0.1:${port}`);
    console.log(`MODELS_DIR=${MODELS_DIR ?? '(not configured)'}`);
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
