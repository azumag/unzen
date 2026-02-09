/**
 * Module bundler for sandbox functions
 *
 * Uses esbuild to bundle npm dependencies into self-contained
 * JavaScript that can run in the QuickJS sandbox.
 *
 * Design decisions:
 * - esbuild resolves and bundles all imports at build time
 *   (no runtime module resolution needed in the sandbox)
 * - Output is IIFE format because QuickJS sandbox has no module system
 * - Target is ES2018 for QuickJS compatibility (QuickJS supports ES2020
 *   but ES2018 is safer for maximum compatibility)
 * - Forbidden APIs are detected in the final bundle as defense-in-depth
 * - Module imports are validated against whitelist BEFORE bundling
 *   to fail fast with clear error messages
 *
 * Bundle pipeline:
 * 1. Extract import statements from source code (pre-check for fast feedback)
 * 2. Validate each import against whitelist + Node.js built-in blocklist
 * 3. Write temp file for esbuild input
 * 4. Bundle with esbuild (IIFE, ES2018, browser platform)
 *    - esbuild onResolve plugin validates ALL modules at resolution time
 *      (catches aliased/transitive imports the pre-check might miss)
 * 5. Scan output for forbidden APIs (defense-in-depth)
 * 6. Transform IIFE output to expose run() function
 * 7. Return bundled code with metadata
 */

import * as esbuild from 'esbuild';
import { checkModuleAllowed, isNodeBuiltin } from './module-whitelist';
import { checkForbiddenApis } from './forbidden-api-check';
import { writeFileSync, mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * Bundle options for configuring the bundling process
 */
export interface BundleOptions {
  /** Function code with import statements */
  code: string;
  /** Allowed module patterns (e.g., ['lodash/*', 'date-fns']) */
  allowedModules: string[];
}

/**
 * Bundle result containing the output and metadata
 */
export interface BundleResult {
  /** Bundled self-contained code ready for sandbox execution */
  code: string;
  /** Bundle size in bytes (UTF-8 encoded) */
  size: number;
  /** List of resolved module names found in import statements */
  modules: string[];
}

/**
 * Bundle function code with npm dependencies into self-contained sandbox code.
 *
 * Process:
 * 1. Parse import statements to validate against whitelist
 * 2. Write temp file for esbuild input
 * 3. Bundle with esbuild (IIFE, ES2018, browser platform)
 * 4. Scan output for forbidden APIs
 * 5. Return bundled code
 *
 * @param options - Bundle configuration
 * @returns Bundled code, size, and module list
 * @throws Error if module not allowed, Node built-in used, or forbidden API detected
 */
export async function bundle(options: BundleOptions): Promise<BundleResult> {
  const { code, allowedModules } = options;

  // Step 1: Extract and validate import statements
  // We validate BEFORE invoking esbuild to fail fast with clear error messages
  const importedModules = extractImports(code);
  for (const mod of importedModules) {
    // Check Node.js built-ins first (always blocked, even if in allowedModules)
    if (isNodeBuiltin(mod)) {
      throw new Error(
        `Module "${mod}" is a Node.js built-in and cannot be used in sandbox functions. ` +
        `Sandbox functions must be pure computations without system access.`
      );
    }
    // Check against the allowed modules whitelist
    if (!checkModuleAllowed(mod, allowedModules)) {
      throw new Error(
        `Module "${mod}" is not in the allowed modules list. ` +
        `Add it to allowedModules to use it: allowedModules: ['${mod}']`
      );
    }
  }

  // Step 2: Write to temp file for esbuild
  // esbuild requires a file path as entry point, so we create a temp file
  const tmpDir = mkdtempSync(join(tmpdir(), 'unzen-bundler-'));
  const entryFile = join(tmpDir, 'entry.js');

  try {
    writeFileSync(entryFile, code);

    // Step 3: Bundle with esbuild
    // Configuration choices:
    // - IIFE format: QuickJS has no module system, IIFE is self-contained
    // - browser platform: prevents Node.js polyfills from being injected
    // - ES2018 target: QuickJS ES2018 compliance (safe lower bound)
    // - write:false: return output in memory instead of writing to disk
    // - globalName: IIFE assigns exports to this variable for extraction
    // - plugins: onResolve hook validates ALL module resolutions (defense-in-depth)
    const result = await esbuild.build({
      entryPoints: [entryFile],
      bundle: true,
      format: 'iife',
      platform: 'browser',
      target: 'es2018',
      write: false, // Return output as string instead of writing to disk
      globalName: '__unzen_module', // IIFE assigns to this variable
      minify: false, // Keep readable for debugging
      logLevel: 'silent', // Suppress esbuild console output
      plugins: [
        // SECURITY: esbuild plugin validates module imports at resolution time.
        // This catches modules that the static pre-check might miss:
        // - Modules aliased via tsconfig paths
        // - Modules resolved from transitive dependencies
        // - Modules loaded via CommonJS require() that esbuild inlines
        createModuleWhitelistPlugin(allowedModules),
      ],
    });

    const output = result.outputFiles?.[0]?.text ?? '';

    // Step 4: Check for forbidden APIs in bundled output (defense-in-depth)
    // Even though imports are whitelisted, transitive dependencies
    // might introduce forbidden API calls
    const violations = checkForbiddenApis(output);
    if (violations.length > 0) {
      throw new Error(
        `Bundled code contains forbidden APIs:\n` +
        violations.map(v => `  - ${v}`).join('\n')
      );
    }

    // Step 5: Transform IIFE output to expose run() function
    // esbuild generates: var __unzen_module = (() => { ... })();
    // We add a fallback chain to make run() accessible at the top level
    const bundledCode = extractRunFunction(output);

    return {
      code: bundledCode,
      size: Buffer.byteLength(bundledCode, 'utf-8'),
      modules: importedModules,
    };
  } finally {
    // Clean up temp directory regardless of success or failure
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}

/**
 * Extract import module names from source code
 *
 * Parses both static import forms:
 * - `import x from 'module'`
 * - `import { x } from 'module'`
 * - `import * as x from 'module'`
 *
 * Does NOT parse dynamic imports (import()) since those can't be
 * statically analyzed and should be caught by the forbidden API check.
 *
 * @param code - Source code with import statements
 * @returns Array of unique module names (deduplicated)
 */
function extractImports(code: string): string[] {
  // Match static import statements with single or double quotes
  // Captures the module specifier (the string inside quotes)
  const importRegex = /import\s+(?:.*?\s+from\s+)?['"](.*?)['"]/g;
  const modules = new Set<string>();

  let match;
  while ((match = importRegex.exec(code)) !== null) {
    modules.add(match[1]);
  }

  return Array.from(modules);
}

/**
 * Extract and wrap the run function from esbuild IIFE output
 *
 * esbuild generates: `var __unzen_module = (() => { ... })();`
 * We append code that extracts the run function from the IIFE exports.
 *
 * The fallback chain handles different export styles:
 * 1. __unzen_module.run - normal named export
 * 2. Global run - if somehow defined at top level
 * 3. Error - if no run function is found
 *
 * @param iifeOutput - Raw esbuild IIFE output
 * @returns Transformed code with accessible run() function
 */
function extractRunFunction(iifeOutput: string): string {
  return `${iifeOutput}\nvar run = typeof __unzen_module !== 'undefined' && __unzen_module.run ? __unzen_module.run : (typeof run !== 'undefined' ? run : function() { throw new Error('No run function exported'); });`;
}

/**
 * Create an esbuild plugin that validates module imports at resolution time.
 *
 * This is a critical security measure that complements the static pre-check:
 * - The pre-check parses import statements from the user's source code
 * - This plugin intercepts ALL module resolutions inside esbuild,
 *   including those from aliased paths, transitive deps, and require() calls
 *
 * The plugin uses the onResolve hook which fires for every module that
 * esbuild tries to resolve, giving us a chance to block forbidden modules
 * before they're bundled.
 *
 * @param allowedModules - Allowed module patterns (e.g., ['lodash/*', 'date-fns'])
 * @returns esbuild plugin instance
 */
function createModuleWhitelistPlugin(allowedModules: string[]): esbuild.Plugin {
  return {
    name: 'unzen-module-whitelist',
    setup(build) {
      // Intercept all non-relative, non-absolute module resolutions.
      // Relative paths (./foo, ../bar) and absolute paths (/foo) are
      // local files, not npm modules, so they don't need whitelist checking.
      build.onResolve({ filter: /^[^./]/ }, (args) => {
        const moduleName = args.path;

        // Block Node.js built-in modules
        if (isNodeBuiltin(moduleName)) {
          return {
            errors: [{
              text: `Module "${moduleName}" is a Node.js built-in and cannot be used in sandbox functions.`,
            }],
          };
        }

        // Block modules not in the whitelist
        if (!checkModuleAllowed(moduleName, allowedModules)) {
          return {
            errors: [{
              text: `Module "${moduleName}" is not in the allowed modules list.`,
            }],
          };
        }

        // Allow esbuild to resolve the module normally
        return undefined;
      });
    },
  };
}
