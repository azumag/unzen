/**
 * Static server for the WebGPU 2B harness (issue #101/PLAN 7.1 step 0
 * measurement path).
 *
 * Serves the harness directory. COOP/COEP are intentionally NOT set: the
 * model artifacts are fetched from huggingface.co, which does not send a
 * Cross-Origin-Resource-Policy header, so COEP `require-corp` would block
 * the downloads. transformers.js v4 runs WebGPU single-threaded (no
 * SharedArrayBuffer dependency), so COOP/COEP are not required here.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT ?? 8788);
// Local diagnostic harness only: bind to loopback so the private model
// artifacts under MODELS_DIR are never exposed to the network.
const HOST = process.env.HOST ?? '127.0.0.1';
// When set, /models/<repo>/... is served from this directory so the runner
// can load model artifacts from disk instead of downloading from
// huggingface.co (see runner.js env.localModelPath). MODELS_DIR content is
// TRUSTED: point it only at a model artifact tree, never at an untrusted
// directory (symlinks inside it are followed).
const MODELS_DIR = process.env.MODELS_DIR ? resolve(process.env.MODELS_DIR) : undefined;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
};

const server = createServer(async (req, res) => {
  // Hardening: only GET/HEAD are allowed for static asset serving.
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end('method not allowed');
    return;
  }
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    // Decode pathname safely; malformed encodings are rejected.
    let rawPathname;
    try {
      rawPathname = decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400).end('bad request');
      return;
    }
    console.log(`${new Date().toISOString()} ${req.method} ${rawPathname}`);
    // Model artifacts are resolved under /models/ against MODELS_DIR when
    // configured; anything else is resolved inside the harness directory.
    let base = resolve(ROOT);
    let pathname = rawPathname;
    if (MODELS_DIR && pathname.startsWith('/models/')) {
      base = MODELS_DIR;
      pathname = pathname.slice('/models/'.length);
      // Prevent empty pathname after slice from escaping base
      if (!pathname) pathname = '/';
    }
    // Normalize and resolve to prevent path traversal (including symlink-escape via resolve).
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
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Cache-Control': pathname.startsWith('/models/') ? 'public, max-age=3600' : 'no-store',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});

async function statSafe(path) {
  try {
    return await stat(path);
  } catch {
    return undefined;
  }
}

server.listen(PORT, HOST, () => {
  console.log(`serving ${ROOT} on http://${HOST}:${PORT}`);
});
