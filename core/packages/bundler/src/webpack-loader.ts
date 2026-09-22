/** webpack loader adapter for compile-time Unzen function extraction. */

import {
  transformUnzenDefinitions,
  transformUnzenDefinitionsWithDependencies,
  type UnzenDependencyBundlingOptions,
} from './source-transform';

export interface UnzenWebpackLoaderOptions {
  /** Opt in to bundling runtime imports referenced by extracted functions. */
  dependencyBundling?: UnzenDependencyBundlingOptions;
}

export type UnzenWebpackLoaderCallback = (
  error: Error | null,
  content?: string,
  sourceMap?: unknown,
  meta?: unknown,
) => void;

export interface UnzenWebpackLoaderContext {
  resourcePath: string;
  sourceMap?: boolean;
  cacheable?(flag?: boolean): void;
  addDependency?(file: string): void;
  getOptions?(): UnzenWebpackLoaderOptions;
  async?(): UnzenWebpackLoaderCallback;
  callback: UnzenWebpackLoaderCallback;
}

/**
 * Normalize loader/tool failures without invoking coercion hooks on an
 * arbitrary object/function thrown across the build-tool boundary.
 */
function normalizeWebpackLoaderError(error: unknown): Error {
  // `instanceof` can itself invoke a Proxy's [[GetPrototypeOf]] trap. Keep
  // classification bounded so a revoked/hostile Proxy cannot replace the
  // intended loader diagnostic with its own exception.
  try {
    if (error instanceof Error) return error;
  } catch {
    // Fall through to the non-Error object/function bucket below.
  }
  if (error === null) return new Error('null');
  if (typeof error === 'object' || typeof error === 'function') {
    return new Error('Unzen webpack loader failed with a non-Error value');
  }
  return new Error(String(error));
}

/**
 * webpack calls loaders with a resource-bound `this` context. The loader uses
 * callback form so it can return the transformed code and source map together,
 * matching webpack's documented loader interface.
 */
export function unzenWebpackLoader(
  this: UnzenWebpackLoaderContext,
  source: string,
  inputSourceMap?: unknown,
  meta?: unknown,
): undefined {
  const dependencyBundling = this.getOptions?.().dependencyBundling;
  if (dependencyBundling) {
    // esbuild reads the package graph outside webpack's loader dependency
    // accounting, so dependency mode must not reuse a stale loader result.
    this.cacheable?.(false);
    const callback = this.async?.() ?? this.callback.bind(this);
    const addDependency = this.addDependency;
    const sourceMapEnabled = this.sourceMap === true;
    void transformUnzenDefinitionsWithDependencies(
      source,
      this.resourcePath,
      dependencyBundling,
    ).then(
      (result) => {
        if (!result) {
          callback(null, source, inputSourceMap, meta);
          return;
        }
        let outputMap: unknown;
        try {
          for (const watchFile of result.watchFiles) {
            if (addDependency) Reflect.apply(addDependency, this, [watchFile]);
          }
          outputMap = sourceMapEnabled ? result.map : undefined;
        } catch (error) {
          callback(normalizeWebpackLoaderError(error));
          return;
        }
        callback(null, result.code, outputMap, meta);
      },
      (error: unknown) => {
        callback(normalizeWebpackLoaderError(error));
      },
    );
    return undefined;
  }

  this.cacheable?.(true);
  const result = transformUnzenDefinitions(source, this.resourcePath);
  if (!result) {
    this.callback(null, source, inputSourceMap, meta);
    return undefined;
  }
  this.callback(null, result.code, this.sourceMap ? result.map : undefined, meta);
  return undefined;
}

export default unzenWebpackLoader;
