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
import { extname, join, normalize } from 'node:path';
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
const MODELS_DIR = process.env.MODELS_DIR ? normalize(process.env.MODELS_DIR) : undefined;

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    console.log(`${new Date().toISOString()} ${req.method} ${url.pathname}`);
    // Model artifacts are resolved under /models/ against MODELS_DIR when
    // configured; anything else is resolved inside the harness directory.
    let base = ROOT;
    let pathname = url.pathname;
    if (MODELS_DIR && pathname.startsWith('/models/')) {
      base = MODELS_DIR.endsWith('/') ? MODELS_DIR : MODELS_DIR + '/';
      pathname = pathname.slice('/models/'.length);
    }
    let path = normalize(join(base, pathname));
    if (!path.startsWith(base)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    if ((await statSafe(path))?.isDirectory()) path = join(path, 'index.html');
    const body = await readFile(path);
    res.writeHead(200, {
      'Content-Type': MIME[extname(path)] ?? 'application/octet-stream',
    });
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
