/**
 * Module whitelist for sandbox function bundling
 *
 * Controls which npm modules can be imported in sandbox functions.
 * Node.js built-in modules are always blocked regardless of whitelist
 * since they provide system access that violates sandbox isolation.
 *
 * Security model:
 * - DENY by default: All modules are blocked unless explicitly allowed
 * - Node.js built-ins are ALWAYS blocked, even if listed in allowed patterns
 * - Only pure-computation npm modules should be whitelisted
 * - Wildcard patterns (e.g., 'lodash/*') allow subpath imports
 */

/**
 * Complete list of Node.js built-in modules (as of Node.js 20+)
 *
 * These are ALWAYS blocked in sandbox functions because they provide
 * direct system access (filesystem, network, process control, etc.)
 * that fundamentally violates the sandbox isolation model.
 */
const NODE_BUILTINS = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster',
  'console', 'constants', 'crypto', 'dgram', 'diagnostics_channel',
  'dns', 'domain', 'events', 'fs', 'http', 'http2', 'https',
  'inspector', 'module', 'net', 'os', 'path', 'perf_hooks',
  'process', 'punycode', 'querystring', 'readline', 'repl',
  'stream', 'string_decoder', 'sys', 'timers', 'tls', 'trace_events',
  'tty', 'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib',
]);

/**
 * Default list of allowed npm modules for sandbox functions.
 *
 * These are pure-computation libraries safe for sandbox use:
 * - No network access, no filesystem access, no process control
 * - Well-known, widely-used, community-audited packages
 * - Wildcard entries (e.g., 'lodash/*') allow subpath imports
 */
export const DEFAULT_ALLOWED_MODULES: string[] = [
  'lodash', 'lodash/*',
  'date-fns', 'date-fns/*',
  'validator',
  'marked',
  'json-schema',
];

/**
 * Check if a module name is a Node.js built-in
 *
 * Handles both bare names (e.g., 'fs') and node: prefixed names
 * (e.g., 'node:fs'). The node: prefix was introduced in Node.js 12
 * as an explicit way to import built-in modules.
 *
 * @param name - Module name (e.g., 'fs', 'node:path')
 * @returns true if the module is a Node.js built-in
 */
export function isNodeBuiltin(name: string): boolean {
  // Handle node: prefix (e.g., 'node:fs' -> 'fs')
  const normalized = name.startsWith('node:') ? name.slice(5) : name;
  return NODE_BUILTINS.has(normalized);
}

/**
 * Check if a module import is allowed by the whitelist
 *
 * Security priority: Node.js built-in modules are ALWAYS blocked,
 * even if explicitly listed in allowedPatterns. This prevents
 * accidental whitelisting of dangerous system modules.
 *
 * Pattern matching:
 * - Exact match: 'lodash' matches only 'lodash'
 * - Wildcard: 'lodash/*' matches 'lodash/sortBy', 'lodash/fp/curry', etc.
 *
 * @param moduleName - The module being imported (e.g., 'lodash/sortBy')
 * @param allowedPatterns - Glob-like patterns (e.g., ['lodash/*', 'date-fns'])
 * @returns true if the module is allowed
 */
export function checkModuleAllowed(
  moduleName: string,
  allowedPatterns: string[]
): boolean {
  // Node.js built-ins are ALWAYS blocked -- they provide system access
  // that fundamentally violates sandbox isolation, regardless of whitelist
  if (isNodeBuiltin(moduleName)) {
    return false;
  }

  // SECURITY: Reject path traversal attacks (e.g., 'lodash/../../fs-extra')
  // An attacker could use '..' segments to escape a whitelisted package prefix
  // and resolve to a completely different (potentially dangerous) module.
  // This check blocks ANY module name containing '..' regardless of context.
  if (moduleName.includes('..')) {
    return false;
  }

  // Check against allowed patterns
  for (const pattern of allowedPatterns) {
    if (pattern === moduleName) {
      return true; // Exact match (e.g., 'lodash' matches 'lodash')
    }

    // Wildcard pattern: 'lodash/*' matches 'lodash/sortBy'
    // The '/*' suffix means "any subpath under this package"
    if (pattern.endsWith('/*')) {
      const prefix = pattern.slice(0, -2); // Remove '/*'
      if (moduleName.startsWith(prefix + '/')) {
        return true;
      }
    }
  }

  return false;
}
