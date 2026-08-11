/**
 * E2E Demo Server
 *
 * Demonstrates the unzen core framework with:
 * - UnzenServer with function registration
 * - Static file serving for demo page
 * - spamCheck function example
 */

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { UnzenServer } from '@unzen/server';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  formValidateCode,
  calculatePriceCode,
  markdownToHtmlCode,
  textStatsCode,
  jsonSchemaValidateCode,
  sortDataCode,
  levenshteinDistanceCode,
  hashPasswordCode,
} from './sample-functions';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = new Hono();

// Initialize UnzenServer
// baseUrl is ORIGIN-RELATIVE ('/unzen') so the manifest's codeUrl stays on the
// same origin/scheme as the page that requested it. A hard-coded
// 'http://localhost:3000/unzen' would be blocked as mixed content when the
// demo is served over HTTPS (issue #104). createManifestResponse() appends
// "/code/<name>?v=...&h=..." to this value, which fetch() resolves against the
// current origin.
const unzenServer = new UnzenServer({
  baseUrl: '/unzen',
});

// Register demo functions
// Function 1: Spam detection (regex-based)
unzenServer.defineRaw('spamCheck', `(text) => {
  const spamKeywords = ['spam', 'buy now', 'click here', 'free money', 'winner'];
  const lowerText = text.toLowerCase();
  return spamKeywords.some(keyword => lowerText.includes(keyword));
}`);

// Function 2: Addition
unzenServer.defineRaw('add', `(a, b) => a + b`);

// Function 3: Multiplication (used by demo page)
unzenServer.defineRaw('multiply', `(a, b) => a * b`);

// Function 4: Double array elements (used by demo page)
unzenServer.defineRaw('doubleArray', `(arr) => arr.map(x => x * 2)`);

// Function 5: User info transformation (used by demo page)
unzenServer.defineRaw('getUserInfo', `(user) => ({
  fullName: user.firstName + ' ' + user.lastName,
  isAdult: user.age >= 18,
  initials: user.firstName[0] + user.lastName[0],
})`);

// Practical sample functions (demonstrating server→browser delegation value)
// Function 6: Tamper-proof form validation (email, credit card, phone, password)
unzenServer.defineRaw('formValidate', formValidateCode);

// Function 7: Secure price calculation (tax, discount, shipping)
unzenServer.defineRaw('calculatePrice', calculatePriceCode);

// Function 8: Markdown→HTML rendering (offload SSR to client)
unzenServer.defineRaw('markdownToHtml', markdownToHtmlCode);

// Function 9: Text statistics with Flesch-Kincaid readability
unzenServer.defineRaw('textStats', textStatsCode);

// Heavy computation sample functions (500ms timeout for CPU-intensive operations)
// These demonstrate the high-value use case: offloading expensive server CPU to browser sandbox

// Function 10: JSON Schema validation (500ms timeout for complex schemas)
unzenServer.defineRaw('jsonSchemaValidate', jsonSchemaValidateCode, { timeout: 500 });

// Function 11: Multi-key data sorting (500ms timeout for large datasets)
unzenServer.defineRaw('sortData', sortDataCode, { timeout: 500 });

// Function 12: Levenshtein edit distance (500ms timeout for O(n*m) computation)
unzenServer.defineRaw('levenshteinDistance', levenshteinDistanceCode, { timeout: 500 });
unzenServer.defineRaw('hashPassword', hashPasswordCode, {
  timeout: 2000,
  noFallback: true, // password must never leave the browser
});

// Real MoonBit payload used by the Service Worker code/Wasm cache E2E.
unzenServer.defineMoonbit(
  'moonbitFibonacci',
  join(__dirname, 'public/moonbit/fibonacci.wasm'),
  { exportName: 'fibonacci' },
);

// Initialize the server
await unzenServer.initialize();

// Mount Unzen middleware
app.route('/unzen', unzenServer.middleware());

// Pre-read static bundles at startup (content is immutable per build).
// Using index.browser.js which inlines all dependencies (@unzen/shared etc.)
// since browsers cannot resolve bare specifiers like "@unzen/shared".
const clientCode = readFileSync(
  join(__dirname, '../packages/client/dist/index.browser.js'), 'utf-8'
);
// QuickJS worker: self-contained bundle with embedded Wasm binary (~505KB).
// Runs in Web Worker thread with 4-layer isolation.
const workerCode = readFileSync(
  join(__dirname, '../packages/client/dist/quickjs-worker.js'), 'utf-8'
);
// MoonBit worker: self-contained bundle for the dedicated wasm-gc worker.
const moonbitWorkerCode = readFileSync(
  join(__dirname, '../packages/client/dist/moonbit-worker.js'), 'utf-8'
);
// Classic Service Worker bundle for persistent immutable function/Wasm cache.
const unzenCacheWorkerCode = readFileSync(
  join(__dirname, '../packages/client/dist/unzen-cache-worker.js'), 'utf-8'
);

app.get('/client.js', (c) => {
  return c.text(clientCode, 200, {
    'Content-Type': 'application/javascript',
    'Cache-Control': 'public, max-age=3600',
  });
});

app.get('/worker.js', (c) => {
  return c.text(workerCode, 200, {
    'Content-Type': 'application/javascript',
    'Cache-Control': 'public, max-age=3600',
  });
});

app.get('/moonbit-worker.js', (c) => {
  return c.text(moonbitWorkerCode, 200, {
    'Content-Type': 'application/javascript',
    'Cache-Control': 'public, max-age=3600',
  });
});

app.get('/unzen-cache-worker.js', (c) => {
  return c.text(unzenCacheWorkerCode, 200, {
    'Content-Type': 'application/javascript',
    // The worker manages immutable code payloads, but its own update check must
    // always reach the server rather than being pinned by an HTTP cache.
    'Cache-Control': 'no-cache',
    'Service-Worker-Allowed': '/',
  });
});

// Serve static files from public directory
// Use absolute path for consistent behavior in tests and direct execution
const publicDir = join(__dirname, 'public');
app.use('/*', serveStatic({ root: publicDir }));

// Export app for testing
export { app };

// Start server only if running directly (not imported)
if (import.meta.url === `file://${process.argv[1]}`) {
  const configuredPort = process.env.UNZEN_DEMO_PORT ?? '3000';
  const port = Number(configuredPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid UNZEN_DEMO_PORT: ${configuredPort}`);
  }
  console.log(`🚀 Demo server running at http://localhost:${port}`);
  console.log(`📄 Demo page: http://localhost:${port}/`);
  console.log(`📋 Manifest: http://localhost:${port}/unzen/manifest`);

  serve({
    fetch: app.fetch,
    port,
  });
}
