import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const clientDist = join(root, 'node_modules', '@unzen', 'client', 'dist');
const publicRoot = join(root, 'public');
const publicDir = join(root, 'public', 'unzen');

await mkdir(publicDir, { recursive: true });
await copyFile(join(clientDist, 'index.browser.js'), join(publicDir, 'client.js'));
await copyFile(join(clientDist, 'quickjs-worker.js'), join(publicDir, 'worker.js'));
await copyFile(
  join(clientDist, 'unzen-cache-worker.js'),
  join(publicRoot, 'unzen-cache-worker.js')
);
