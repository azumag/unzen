/**
 * Forbidden API detection for bundled sandbox code
 *
 * Scans bundled JavaScript output for APIs that would be blocked
 * by the QuickJS sandbox. These APIs require network or system access
 * that violates the sandbox isolation model.
 *
 * This is a defense-in-depth measure: even if a module passes the
 * whitelist check, its bundled output might contain forbidden API calls
 * from transitive dependencies. For example, a whitelisted module
 * might internally use fetch() through a dependency chain.
 *
 * Detection approach:
 * - Regex-based pattern matching on the bundled output
 * - Each pattern uses word boundaries (\b) to avoid false positives
 *   from variable names containing forbidden words
 * - Patterns match function call syntax (e.g., 'fetch(' not just 'fetch')
 *   to reduce false positives from comments or string literals
 *
 * Limitations:
 * - Cannot detect dynamically constructed API calls (e.g., window['fe'+'tch'])
 * - May produce false positives for string literals containing API names
 * - This is a heuristic, not a formal proof of safety
 */

/**
 * Patterns for APIs forbidden in sandbox functions.
 *
 * Each entry includes:
 * - pattern: Regex to match the forbidden API usage
 * - description: Human-readable explanation of why it's blocked
 *
 * Categories of forbidden APIs:
 * 1. Network access: fetch, XMLHttpRequest, WebSocket
 * 2. Dynamic code loading: importScripts, eval, Function constructor
 * 3. Module loading: require(), dynamic import()
 */
const FORBIDDEN_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
  {
    pattern: /\bfetch\s*\(/,
    description: 'fetch() - network requests are blocked in sandbox',
  },
  {
    pattern: /\bXMLHttpRequest\b/,
    description: 'XMLHttpRequest - network requests are blocked in sandbox',
  },
  {
    pattern: /\bWebSocket\b/,
    description: 'WebSocket - network connections are blocked in sandbox',
  },
  {
    pattern: /\bimportScripts\b/,
    description: 'importScripts - dynamic script loading is blocked in sandbox',
  },
  {
    pattern: /\beval\s*\(/,
    description: 'eval() - dynamic code execution is blocked in sandbox',
  },
  {
    // Detect `new Function(...)` which allows arbitrary code execution.
    // Uses word boundary + capital F to distinguish from regular function declarations.
    pattern: /\bnew\s+Function\s*\(/,
    description: 'new Function() - dynamic code execution is blocked in sandbox',
  },
  {
    // Detect `require(...)` calls which can load arbitrary Node.js modules.
    // In bundled output, require() should never appear since esbuild resolves
    // all imports. Its presence indicates an intentional bypass attempt.
    pattern: /\brequire\s*\(/,
    description: 'require() - dynamic module loading is blocked in sandbox',
  },
  {
    // Detect dynamic `import(...)` calls (ES2020 dynamic imports).
    // These can load modules at runtime, bypassing the whitelist.
    // We match `import(` NOT preceded by a word char to avoid matching
    // static import statements (which don't have parentheses).
    pattern: /\bimport\s*\(/,
    description: 'dynamic import() - dynamic module loading is blocked in sandbox',
  },
];

/**
 * Check bundled code for forbidden API usage
 *
 * Scans the entire bundled output (including inlined dependencies)
 * for patterns that indicate usage of APIs forbidden in the sandbox.
 *
 * @param code - Bundled JavaScript code to scan
 * @returns Array of violation descriptions (empty array if clean)
 */
export function checkForbiddenApis(code: string): string[] {
  const violations: string[] = [];

  for (const { pattern, description } of FORBIDDEN_PATTERNS) {
    if (pattern.test(code)) {
      violations.push(description);
    }
  }

  return violations;
}
