import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { isPathWithinRoot } from '../webgpu-2b-split/server-safe-path.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
};

async function statSafe(path, statFn) {
  try {
    return await statFn(path);
  } catch {
    return undefined;
  }
}

export async function resolveWebgpu2bStaticResponse({
  method,
  rawPathname,
  root,
  modelsDir,
  readFileFn = readFile,
  statFn = stat,
}) {
  let base = resolve(root);
  let pathname = rawPathname;
  const isModelArtifactRequest = Boolean(modelsDir) && pathname.startsWith('/models/');
  if (isModelArtifactRequest) {
    base = resolve(modelsDir);
    pathname = pathname.slice('/models/'.length);
    if (!pathname) pathname = '/';
  }

  const target = normalize(join(base, pathname));
  const resolvedBase = resolve(base);
  const resolvedTarget = resolve(target);
  if (!isPathWithinRoot(resolvedBase, resolvedTarget)) {
    return { status: 403, headers: {}, body: 'forbidden' };
  }

  let file = resolvedTarget;
  let info = await statSafe(file, statFn);
  if (info?.isDirectory()) {
    file = join(file, 'index.html');
    info = await statSafe(file, statFn);
  }
  if (!info?.isFile()) {
    return { status: 404, headers: {}, body: 'not found' };
  }

  const headers = {
    'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Cache-Control': isModelArtifactRequest ? 'public, max-age=3600' : 'no-store',
  };

  if (method === 'HEAD') {
    return { status: 200, headers, body: undefined };
  }

  try {
    const body = await readFileFn(file);
    return { status: 200, headers, body };
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      return { status: 404, headers: {}, body: 'not found' };
    }
    throw error;
  }
}
