/**
 * @unzen/bundler
 *
 * Module bundler for sandbox functions.
 * Bundles npm dependencies into self-contained code for QuickJS sandbox.
 *
 * Main entry point that re-exports the public API:
 * - bundle(): Main bundling function
 * - checkModuleAllowed(): Module whitelist validation
 * - isNodeBuiltin(): Node.js built-in module detection
 * - DEFAULT_ALLOWED_MODULES: Default safe module list
 * - checkForbiddenApis(): Forbidden API detection in bundled code
 *
 * @module @unzen/bundler
 */

export { bundle, type BundleOptions, type BundleResult } from './bundler';
export {
  checkModuleAllowed,
  isNodeBuiltin,
  DEFAULT_ALLOWED_MODULES,
} from './module-whitelist';
export { checkForbiddenApis } from './forbidden-api-check';
export {
  transformUnzenDefinitions,
  transformUnzenDefinitionsWithDependencies,
  UnzenTransformError,
  type ExtractedUnzenDefinition,
  type ExtractedUnzenParameter,
  type UnzenDependencyBundlingOptions,
  type UnzenSourceTransformResult,
} from './source-transform';
export {
  generateUnzenTypeDeclarations,
  UnzenTypeGenerationError,
} from './type-declarations';
export {
  unzenVitePlugin,
  type UnzenViteEmitContext,
  type UnzenVitePlugin,
  type UnzenVitePluginOptions,
  type UnzenViteTransformResult,
} from './vite-plugin';
export {
  unzenWebpackLoader,
  type UnzenWebpackLoaderCallback,
  type UnzenWebpackLoaderContext,
  type UnzenWebpackLoaderOptions,
} from './webpack-loader';
