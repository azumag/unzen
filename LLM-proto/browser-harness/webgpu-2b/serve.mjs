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
    let path = normalize(join(ROOT, url.pathname));
    if (!path.startsWith(ROOT)) {
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

server.listen(PORT, () => {
  console.log(`serving ${ROOT} on http://localhost:${PORT}`);
});
