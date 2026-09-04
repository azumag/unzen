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

import { isBuiltin } from 'node:module';

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
 * Check if a module name is a Node.js built-in.
 *
 * `module.isBuiltin()` is used instead of deriving aliases from
 * `builtinModules`: some built-ins (notably `node:test`) are intentionally
 * available only with the `node:` prefix. Inventing or omitting aliases here
 * can either block safe npm names or, worse, let a built-in through the
 * sandbox whitelist.
 *
 * @param name - Module name (e.g., 'fs', 'node:path', 'node:test')
 * @returns true if the module is a Node.js built-in
 */
export function isNodeBuiltin(name: string): boolean {
  return isBuiltin(name);
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
