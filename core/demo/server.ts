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
} from './sample-functions';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = new Hono();

// Initialize UnzenServer
const unzenServer = new UnzenServer({
  baseUrl: 'http://localhost:3000/unzen',
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

// Initialize the server
await unzenServer.initialize();

// Mount Unzen middleware
app.route('/unzen', unzenServer.middleware());

// Serve @unzen/client bundle for browser import
app.get('/client.js', (c) => {
  const clientPath = join(__dirname, '../packages/client/dist/index.js');
  const clientCode = readFileSync(clientPath, 'utf-8');
  return c.text(clientCode, 200, {
    'Content-Type': 'application/javascript',
    'Cache-Control': 'public, max-age=3600',
  });
});

// Serve QuickJS worker script for browser-side sandbox execution.
// This is the self-contained bundle with embedded Wasm binary (~505KB uncompressed).
// The worker runs in a Web Worker thread, providing 4-layer isolation:
// Web Worker + Wasm + QuickJS + API restrictions.
app.get('/worker.js', (c) => {
  const workerPath = join(__dirname, '../packages/client/dist/quickjs-worker.js');
  const workerCode = readFileSync(workerPath, 'utf-8');
  return c.text(workerCode, 200, {
    'Content-Type': 'application/javascript',
    'Cache-Control': 'public, max-age=3600',
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
  const port = 3000;
  console.log(`🚀 Demo server running at http://localhost:${port}`);
  console.log(`📄 Demo page: http://localhost:${port}/`);
  console.log(`📋 Manifest: http://localhost:${port}/unzen/manifest`);

  serve({
    fetch: app.fetch,
    port,
  });
}
