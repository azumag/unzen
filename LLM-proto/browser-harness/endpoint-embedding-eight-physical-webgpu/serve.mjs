import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { basename, extname, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateEndpointEmbeddingEightPhysicalPreflightReport } from './contract.js';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const DATA_DIR = process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : null;
const PREFLIGHT_REPORT = process.env.PREFLIGHT_REPORT ? resolve(process.env.PREFLIGHT_REPORT) : null;
const GRAPH_PATH = process.env.GRAPH_PATH ? resolve(process.env.GRAPH_PATH) : null;
const PORT = Number(process.env.PORT ?? 8797);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.onnx': 'application/octet-stream',
  '.bin': 'application/octet-stream',
};

if (!DATA_DIR) throw new Error('DATA_DIR is required');
if (!PREFLIGHT_REPORT) throw new Error('PREFLIGHT_REPORT is required');
if (!GRAPH_PATH) throw new Error('GRAPH_PATH is required');
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535');
}

function safePath(root, relative) {
  const value = resolve(root, `.${normalize(`/${relative}`)}`);
  if (value !== root && !value.startsWith(`${root}/`)) throw new Error('path escapes root');
  return value;
}

async function requireNonSymlinkDirectory(path, field) {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error(`${field} must not be a symbolic link`);
  if (!info.isDirectory()) throw new Error(`${field} must be a directory`);
}

async function requireNonSymlinkFile(path, field) {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error(`${field} must not be a symbolic link`);
  if (!info.isFile()) throw new Error(`${field} must be a regular file`);
  return info;
}

async function readNonSymlinkJson(path, field) {
  await requireNonSymlinkFile(path, field);
  return JSON.parse(await readFile(path, 'utf8'));
}

await requireNonSymlinkDirectory(DATA_DIR, 'DATA_DIR');
const preflight = validateEndpointEmbeddingEightPhysicalPreflightReport(
  await readNonSymlinkJson(PREFLIGHT_REPORT, 'PREFLIGHT_REPORT'),
);
const preflightBody = Buffer.from(`${JSON.stringify(preflight)}\n`, 'utf8');
await requireNonSymlinkFile(GRAPH_PATH, 'GRAPH_PATH');
if (basename(GRAPH_PATH) !== preflight.graph.file) {
  throw new Error(`GRAPH_PATH basename must be ${preflight.graph.file}`);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    if (url.pathname === '/data/preflight.json') {
      res.writeHead(200, {
        'Content-Type': MIME['.json'],
        'Content-Length': preflightBody.byteLength,
        'Cache-Control': 'no-store',
      });
      res.end(preflightBody);
      return;
    }

    let path;
    if (url.pathname === `/data/${preflight.graph.file}`) {
      path = GRAPH_PATH;
    } else if (url.pathname.startsWith('/data/')) {
      path = safePath(DATA_DIR, url.pathname.slice('/data/'.length));
    } else {
      path = safePath(ROOT, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
    }
    const info = await requireNonSymlinkFile(path, 'requested path');
    res.writeHead(200, {
      'Content-Type': MIME[extname(path)] ?? 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': 'no-store',
    });
    createReadStream(path).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`endpoint embedding 8-physical WebGPU diagnostic: http://127.0.0.1:${PORT}/`);
});
