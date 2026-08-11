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
        for (const watchFile of result.watchFiles) {
          this.addDependency?.(watchFile);
        }
        callback(null, result.code, this.sourceMap ? result.map : undefined, meta);
      },
      (error: unknown) => {
        callback(error instanceof Error ? error : new Error(String(error)));
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
