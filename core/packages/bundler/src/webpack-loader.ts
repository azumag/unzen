/** webpack loader adapter for compile-time Unzen function extraction. */

import { transformUnzenDefinitions } from './source-transform';

export interface UnzenWebpackLoaderContext {
  resourcePath: string;
  sourceMap?: boolean;
  cacheable?(flag?: boolean): void;
  callback(
    error: Error | null,
    content: string,
    sourceMap?: unknown,
    meta?: unknown,
  ): void;
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
