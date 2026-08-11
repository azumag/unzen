/** Vite adapter for compile-time Unzen function extraction. */

import {
  transformUnzenDefinitions,
  type UnzenSourceTransformResult,
} from './source-transform';

const MODULE_EXTENSION = /\.(?:[cm]?[jt]sx?)$/i;

export interface UnzenVitePluginOptions {
  /** Optional path filter applied after the default JS/TS and node_modules checks. */
  include?: RegExp | RegExp[];
  /** Optional path filter that takes precedence over include. */
  exclude?: RegExp | RegExp[];
}

export interface UnzenViteTransformResult {
  code: string;
  map: UnzenSourceTransformResult['map'];
}

/** Minimal structural type compatible with Vite/Rollup without a runtime Vite dependency. */
export interface UnzenVitePlugin {
  name: 'unzen-function-extraction';
  enforce: 'pre';
  transform(code: string, id: string): UnzenViteTransformResult | null;
}

function matches(patterns: RegExp | RegExp[] | undefined, value: string): boolean {
  if (patterns === undefined) return false;
  const list = Array.isArray(patterns) ? patterns : [patterns];
  return list.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(value);
  });
}

function shouldTransform(id: string, options: UnzenVitePluginOptions): boolean {
  if (
    id.startsWith('\0')
    || id.includes('?')
    || /(?:^|[/\\])node_modules(?:[/\\]|$)/.test(id)
    || !MODULE_EXTENSION.test(id)
  ) {
    return false;
  }
  if (matches(options.exclude, id)) return false;
  return options.include === undefined || matches(options.include, id);
}

/** Create a Vite pre-transform plugin using the shared AST transformation. */
export function unzenVitePlugin(options: UnzenVitePluginOptions = {}): UnzenVitePlugin {
  return {
    name: 'unzen-function-extraction',
    enforce: 'pre',
    transform(code, id) {
      if (!shouldTransform(id, options)) return null;
      const result = transformUnzenDefinitions(code, id);
      return result ? { code: result.code, map: result.map } : null;
    },
  };
}
