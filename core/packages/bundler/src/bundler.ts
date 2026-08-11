/**
 * Module bundler for sandbox functions
 *
 * Uses esbuild to bundle npm dependencies into self-contained
 * JavaScript that can run in the QuickJS sandbox.
 *
 * Design decisions:
 * - esbuild resolves and bundles all imports at build time
 *   (no runtime module resolution needed in the sandbox)
 * - esbuild emits an internal IIFE, wrapped in the sandbox's function run contract
 * - Target is ES2018 for QuickJS compatibility (QuickJS supports ES2020
 *   but ES2018 is safer for maximum compatibility)
 * - Forbidden APIs are detected in the final bundle as defense-in-depth
 * - Module imports are validated against whitelist BEFORE bundling
 *   to fail fast with clear error messages
 *
 * Bundle pipeline:
 * 1. Analyze static imports/re-exports and reject dynamic imports
 * 2. Validate each static module against whitelist + Node.js built-in blocklist
 * 3. Bundle the in-memory entry from the configured project directory
 *    (IIFE, ES2018, browser platform)
 *    - esbuild onResolve plugin validates ALL modules at resolution time
 *      (catches aliased/transitive imports the pre-check might miss)
 * 4. Collect absolute dependency files from esbuild's metafile
 * 5. Wrap IIFE output as function run and enforce the payload size limit
 * 6. Scan output for forbidden APIs (defense-in-depth)
 * 7. Return bundled code with metadata
 */

import * as esbuild from 'esbuild';
import { resolve } from 'node:path';
import ts from 'typescript';
import { checkModuleAllowed, isNodeBuiltin } from './module-whitelist';
import { checkForbiddenApis } from './forbidden-api-check';

/** Default maximum size of one self-contained sandbox function (100 KiB). */
export const DEFAULT_MAX_BUNDLE_SIZE_BYTES = 100 * 1024;

/**
 * Bundle options for configuring the bundling process
 */
export interface BundleOptions {
  /** Function code with import statements */
  code: string;
  /** Allowed module patterns (e.g., ['lodash/*', 'date-fns']) */
  allowedModules: string[];
  /** Directory used to resolve imports; defaults to the caller's working directory. */
  resolveDir?: string;
  /** Maximum UTF-8 byte size of the final function; defaults to 100 KiB. */
  maxBundleSize?: number;
}

/**
 * Bundle result containing the output and metadata
 */
export interface BundleResult {
  /** Bundled self-contained code ready for sandbox execution */
  code: string;
  /** Bundle size in bytes (UTF-8 encoded) */
  size: number;
  /** Static import and re-export specifiers found in the entry source */
  modules: string[];
  /** Absolute files read by esbuild, excluding the in-memory entry. */
  watchFiles: string[];
}

interface EntryImportAnalysis {
  modules: string[];
  hasDynamicImport: boolean;
}

const DYNAMIC_IMPORT_VIOLATION =
  'dynamic import() - dynamic module loading is blocked in sandbox';

function normalizeMaxBundleSize(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_BUNDLE_SIZE_BYTES;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      `Invalid maxBundleSize ${String(value)}: `
      + "maxBundleSize must be a positive integer within JavaScript's safe range",
    );
  }
  return value;
}

/**
 * Bundle function code with npm dependencies into self-contained sandbox code.
 *
 * Process:
 * 1. Analyze module syntax, reject dynamic imports, and validate static modules
 * 2. Bundle the in-memory entry relative to resolveDir
 * 3. Collect absolute dependency files from esbuild's metafile
 * 4. Wrap the output and enforce the configured UTF-8 byte limit
 * 5. Scan output for forbidden APIs
 * 6. Return bundled code
 *
 * @param options - Bundle configuration
 * @returns Bundled code, size, module list, and dependency files
 * @throws Error if configuration or size is invalid, a module is blocked,
 * or an API is forbidden
 */
export async function bundle(options: BundleOptions): Promise<BundleResult> {
  const { code, allowedModules } = options;
  const resolveDir = resolve(options.resolveDir ?? process.cwd());
  const maxBundleSize = normalizeMaxBundleSize(options.maxBundleSize);

  // Step 1: Analyze and validate module syntax.
  // We validate BEFORE invoking esbuild to fail fast with clear error messages
  const importAnalysis = analyzeEntryImports(code);
  const importedModules = importAnalysis.modules;
  if (importAnalysis.hasDynamicImport) {
    throw new Error(
      'Source code contains forbidden APIs:\n' +
      `  - ${DYNAMIC_IMPORT_VIOLATION}`,
    );
  }
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

  // Step 2: Bundle the in-memory entry relative to the caller's project.
  // stdin.resolveDir is required for esbuild to locate package dependencies.
  const result = await esbuild.build({
    absWorkingDir: resolveDir,
    stdin: {
      contents: code,
      loader: 'js',
      resolveDir,
    },
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2018',
    write: false,
    metafile: true,
    globalName: '__unzen_module',
    minify: false,
    logLevel: 'silent',
    plugins: [createModuleWhitelistPlugin(allowedModules)],
  });

  const output = result.outputFiles?.[0]?.text ?? '';
  const watchFiles = Array.from(new Set(
    Object.keys(result.metafile?.inputs ?? {})
      .filter((input) => !input.startsWith('<'))
      .map((input) => resolve(resolveDir, input)),
  )).sort();

  // Step 3: Measure the exact payload registered through defineRaw. Reject oversized
  // output before the more expensive AST security scan and before it can reach
  // a memory-constrained QuickJS runtime.
  const bundledCode = extractRunFunction(output);
  const size = Buffer.byteLength(bundledCode, 'utf8');
  if (size > maxBundleSize) {
    const unit = maxBundleSize === 1 ? 'byte' : 'bytes';
    throw new Error(
      `Bundled code is ${size} bytes and exceeds maxBundleSize `
      + `of ${maxBundleSize} ${unit}. Reduce imported code or configure `
      + 'a larger limit explicitly.',
    );
  }

  // Step 4: Whitelisted transitive dependencies can still introduce APIs that
  // the sandbox intentionally does not expose.
  const violations = checkForbiddenApis(output);
  if (violations.length > 0) {
    throw new Error(
      `Bundled code contains forbidden APIs:\n` +
      violations.map(v => `  - ${v}`).join('\n')
    );
  }

  return {
    code: bundledCode,
    size,
    modules: importedModules,
    watchFiles,
  };
}

/**
 * Analyze module syntax in the in-memory entry.
 *
 * Collects static import forms:
 * - `import x from 'module'`
 * - `import { x } from 'module'`
 * - `import * as x from 'module'`
 * - `export { x } from 'module'`
 *
 * Dynamic imports are recorded separately and rejected before esbuild can
 * lower them into promise-based loader code that no longer contains import().
 *
 * @param code - Source code with import statements
 * @returns Static module specifiers and whether dynamic import is present
 */
function analyzeEntryImports(code: string): EntryImportAnalysis {
  const sourceFile = ts.createSourceFile(
    'unzen-entry.js',
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const modules = new Set<string>();
  let hasDynamicImport = false;

  for (const statement of sourceFile.statements) {
    if (
      (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))
      && statement.moduleSpecifier
      && ts.isStringLiteralLike(statement.moduleSpecifier)
    ) {
      modules.add(statement.moduleSpecifier.text);
    }
  }

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      hasDynamicImport = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return { modules: Array.from(modules), hasDynamicImport };
}

/**
 * Wrap the esbuild module in the sandbox's `function run` contract.
 *
 * @param iifeOutput - Raw esbuild IIFE output
 * @returns Self-contained code that defineRaw can register verbatim
 */
function extractRunFunction(iifeOutput: string): string {
  const moduleCode = iifeOutput.trimEnd().split('\n')
    .map(line => `  ${line}`)
    .join('\n');
  return `function run(...args) {\n${moduleCode}\n`
    + `  const __unzen_entry = __unzen_module && __unzen_module.run;\n`
    + `  if (typeof __unzen_entry !== 'function') {\n`
    + `    throw new Error('No run function exported');\n`
    + `  }\n`
    + `  return __unzen_entry(...args);\n`
    + `}`;
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
      // Dynamic imports must be rejected before esbuild lowers them into code
      // that no longer contains import(). This callback also covers relative
      // imports inside transitive dependencies.
      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind !== 'dynamic-import') return undefined;
        return { errors: [{ text: DYNAMIC_IMPORT_VIOLATION }] };
      });

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
