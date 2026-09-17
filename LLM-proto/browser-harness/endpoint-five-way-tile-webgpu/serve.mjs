import { createServer } from 'node:http';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openExistingFileWithinRoot } from '../webgpu-2b-split/server-safe-path.mjs';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const SHARED_SPLIT_ROOT = resolve(ROOT, '../webgpu-2b-split');
const DATA_DIR = process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : null;
const PORT = Number(process.env.PORT ?? 8793);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.onnx': 'application/octet-stream', '.bin': 'application/octet-stream' };
if (!DATA_DIR) throw new Error('DATA_DIR is required');

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    let selectedRoot;
    let relativePath;
    if (url.pathname.startsWith('/data/')) {
      selectedRoot = DATA_DIR;
      relativePath = url.pathname.slice('/data/'.length);
    } else if (url.pathname.startsWith('/webgpu-2b-split/')) {
      selectedRoot = SHARED_SPLIT_ROOT;
      relativePath = url.pathname.slice('/webgpu-2b-split/'.length);
    } else {
      selectedRoot = ROOT;
      relativePath = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    }
    const { path, info, stream } = await openExistingFileWithinRoot(selectedRoot, relativePath);
    stream.once('error', () => {
      if (!res.destroyed) res.destroy();
    });
    res.once('close', () => {
      if (!stream.destroyed) stream.destroy();
    });
    try {
      res.writeHead(200, { 'Content-Type': MIME[extname(path)] ?? 'application/octet-stream', 'Content-Length': info.size, 'Cache-Control': 'no-store' });
      stream.pipe(res);
    } catch (error) {
      stream.destroy();
      throw error;
    }
  } catch (error) {
    if (res.headersSent || res.destroyed) {
      if (!res.destroyed) res.destroy();
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
});
server.listen(PORT, '127.0.0.1', () => console.log(`endpoint 5-way WebGPU diagnostic: http://127.0.0.1:${PORT}/`));
