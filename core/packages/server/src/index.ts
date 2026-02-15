/**
 * @unzen/server
 *
 * Server-side framework for unzen core.
 *
 * Built on Hono for edge-native deployment:
 * - Lightweight and fast
 * - Compatible with Cloudflare Workers, Deno, Node.js
 * - First-class TypeScript support
 *
 * Key responsibilities:
 * - Serve WASM modules (QuickJS, MoonBit)
 * - Handle function registration requests
 * - Validate and execute sandboxed code
 * - Coordinate browser-based execution
 *
 * @example
 * ```typescript
 * import { UnzenServer } from '@unzen/server';
 * import { serve } from '@hono/node-server';
 *
 * const server = new UnzenServer({
 *   baseUrl: 'https://example.com/unzen',
 * });
 *
 * // Register functions
 * server.define('spamCheck', (text: string) => {
 *   return /spam/i.test(text);
 * });
 *
 * // Mount middleware
 * const app = new Hono();
 * app.route('/unzen', server.middleware());
 *
 * serve(app);
 * ```
 */

// Main server class
export { UnzenServer } from './unzen-server';
export type { UnzenServerConfig } from './unzen-server';

// Internal components (exported for advanced use cases)
export { FunctionRegistry } from './function-registry';
export { ManifestBuilder } from './manifest-builder';
export { QuickJSRuntime } from './quickjs-runtime';
