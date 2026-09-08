import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const DATA_DIR = process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : null;
const PORT = Number(process.env.PORT ?? 8796);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.onnx': 'application/octet-stream',
  '.bin': 'application/octet-stream',
};
if (!DATA_DIR) throw new Error('DATA_DIR is required');

function safePath(root, relative) {
  const value = resolve(root, `.${normalize(`/${relative}`)}`);
  if (value !== root && !value.startsWith(`${root}/`)) throw new Error('path escapes root');
  return value;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    const path = url.pathname.startsWith('/data/')
      ? safePath(DATA_DIR, url.pathname.slice('/data/'.length))
      : safePath(ROOT, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
    const info = await stat(path);
    if (!info.isFile()) throw new Error('not a file');
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
  console.log(`endpoint embedding tiled WebGPU diagnostic: http://127.0.0.1:${PORT}/`);
});
