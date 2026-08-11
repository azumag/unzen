/** Vite adapter for compile-time Unzen function extraction. */

import {
  transformUnzenDefinitions,
  transformUnzenDefinitionsWithDependencies,
  type ExtractedUnzenDefinition,
  type UnzenDependencyBundlingOptions,
  type UnzenSourceTransformResult,
} from './source-transform';
import { generateUnzenTypeDeclarations, UnzenTypeGenerationError } from './type-declarations';

const MODULE_EXTENSION = /\.(?:[cm]?[jt]sx?)$/i;

export interface UnzenVitePluginOptions {
  /** Optional path filter applied after the default JS/TS and node_modules checks. */
  include?: RegExp | RegExp[];
  /** Optional path filter that takes precedence over include. */
  exclude?: RegExp | RegExp[];
  /** Build asset path for generated declarations; omitted to disable emission. */
  declarationFile?: string | false;
  /** Opt in to bundling runtime imports referenced by extracted functions. */
  dependencyBundling?: UnzenDependencyBundlingOptions;
}

export interface UnzenViteTransformResult {
  code: string;
  map: UnzenSourceTransformResult['map'];
}

/** Minimal structural type compatible with Vite/Rollup without a runtime Vite dependency. */
export interface UnzenVitePlugin {
  name: 'unzen-function-extraction';
  enforce: 'pre';
  buildStart(): void;
  transform(
    this: UnzenViteTransformContext,
    code: string,
    id: string,
  ): UnzenViteTransformResult | null | Promise<UnzenViteTransformResult | null>;
  generateBundle(this: UnzenViteEmitContext): void;
}

export interface UnzenViteTransformContext {
  addWatchFile?(id: string): void;
}

export interface UnzenViteEmitContext {
  emitFile(asset: {
    type: 'asset';
    fileName: string;
    source: string;
  }): string;
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

function normalizeDeclarationFile(value: string | false | undefined): string | undefined {
  if (value === undefined || value === false) return undefined;
  const normalized = value.replace(/\\/g, '/');
  const segments = normalized.split('/');
  if (
    normalized.length === 0
    || normalized.startsWith('/')
    || /^[A-Za-z]:\//.test(normalized)
    || segments.includes('..')
    || !normalized.endsWith('.d.ts')
  ) {
    throw new UnzenTypeGenerationError(
      'declarationFile must be a relative .d.ts asset path without parent traversal',
    );
  }
  return normalized;
}

/** Create a Vite pre-transform plugin using the shared AST transformation. */
export function unzenVitePlugin(options: UnzenVitePluginOptions = {}): UnzenVitePlugin {
  const declarationFile = normalizeDeclarationFile(options.declarationFile);
  const definitionsByFile = new Map<string, ExtractedUnzenDefinition[]>();
  const latestTransformByFile = new Map<string, object>();
  let activeBuildToken: object = {};
  return {
    name: 'unzen-function-extraction',
    enforce: 'pre',
    buildStart() {
      activeBuildToken = {};
      latestTransformByFile.clear();
      definitionsByFile.clear();
    },
    transform(code, id) {
      if (!shouldTransform(id, options)) return null;
      const transformBuildToken = activeBuildToken;
      const transformToken = {};
      latestTransformByFile.set(id, transformToken);
      const recordResult = (
        result: UnzenSourceTransformResult | null,
      ): UnzenViteTransformResult | null => {
        // Async transforms may finish out of invocation order or after the next
        // build starts. Only the newest invocation may replace this snapshot.
        if (
          activeBuildToken === transformBuildToken
          && latestTransformByFile.get(id) === transformToken
        ) {
          if (result) definitionsByFile.set(id, result.definitions);
          else definitionsByFile.delete(id);
        }
        for (const watchFile of result?.watchFiles ?? []) {
          this.addWatchFile?.(watchFile);
        }
        return result ? { code: result.code, map: result.map } : null;
      };

      if (options.dependencyBundling) {
        return transformUnzenDefinitionsWithDependencies(
          code,
          id,
          options.dependencyBundling,
        ).then(recordResult);
      }
      return recordResult(transformUnzenDefinitions(code, id));
    },
    generateBundle() {
      if (declarationFile === undefined) return;
      this.emitFile({
        type: 'asset',
        fileName: declarationFile,
        source: generateUnzenTypeDeclarations(
          [...definitionsByFile.values()].flat(),
        ),
      });
    },
  };
}
