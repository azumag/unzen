/** Vite adapter for compile-time Unzen function extraction. */

import {
  transformUnzenDefinitions,
  transformUnzenDefinitionsWithDependencies,
  snapshotUnzenDependencyBundlingOptions,
  type ExtractedUnzenDefinition,
  type UnzenDependencyBundlingOptions,
  type UnzenSourceTransformResult,
} from './source-transform';
import { generateUnzenTypeDeclarations, UnzenTypeGenerationError } from './type-declarations';

const MODULE_EXTENSION = /\.(?:[cm]?[jt]sx?)$/i;
export const MAX_VITE_FILTER_PATTERNS = 1024;

const REGEXP_SOURCE_GETTER = Object.getOwnPropertyDescriptor(RegExp.prototype, 'source')!.get!;
const REGEXP_FLAGS_GETTER = Object.getOwnPropertyDescriptor(RegExp.prototype, 'flags')!.get!;

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

interface UnzenVitePluginOptionsSnapshot {
  readonly include?: RegExp[];
  readonly exclude?: RegExp[];
  readonly declarationFile?: string;
  readonly dependencyBundling?: ReturnType<typeof snapshotUnzenDependencyBundlingOptions>;
}

function snapshotFilters(value: unknown, name: 'include' | 'exclude'): RegExp[] | undefined {
  if (value === undefined) return undefined;
  const source = Array.isArray(value) ? value : [value];
  let count: unknown;
  try {
    count = source.length;
  } catch {
    throw new TypeError(`${name} filters could not be read`);
  }
  if (
    typeof count !== 'number'
    || !Number.isSafeInteger(count)
    || count < 0
    || count > MAX_VITE_FILTER_PATTERNS
  ) {
    throw new TypeError(`${name} must contain at most ${MAX_VITE_FILTER_PATTERNS} filters`);
  }

  const filters = new Array<RegExp>(count);
  try {
    for (let index = 0; index < count; index += 1) {
      const pattern = source[index];
      const expression = Reflect.apply(REGEXP_SOURCE_GETTER, pattern, []) as string;
      const flags = Reflect.apply(REGEXP_FLAGS_GETTER, pattern, []) as string;
      filters[index] = new RegExp(expression, flags);
    }
  } catch {
    throw new TypeError(`${name} must be a RegExp or an array of RegExp values`);
  }
  return filters;
}

function snapshotVitePluginOptions(value: unknown): UnzenVitePluginOptionsSnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Unzen Vite plugin options must be an object');
  }
  let include: unknown;
  let exclude: unknown;
  let declarationFile: unknown;
  let dependencyBundling: unknown;
  try {
    const record = value as Record<string, unknown>;
    include = record.include;
    exclude = record.exclude;
    declarationFile = record.declarationFile;
    dependencyBundling = record.dependencyBundling;
  } catch {
    throw new TypeError('Unzen Vite plugin options could not be read');
  }
  const normalizedDeclarationFile = normalizeDeclarationFile(declarationFile);

  return {
    ...(include !== undefined && { include: snapshotFilters(include, 'include') }),
    ...(exclude !== undefined && { exclude: snapshotFilters(exclude, 'exclude') }),
    ...(normalizedDeclarationFile !== undefined && {
      declarationFile: normalizedDeclarationFile,
    }),
    ...(dependencyBundling !== undefined && {
      dependencyBundling: snapshotUnzenDependencyBundlingOptions(dependencyBundling),
    }),
  };
}

function matches(patterns: RegExp[] | undefined, value: string): boolean {
  if (patterns === undefined) return false;
  return patterns.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(value);
  });
}

function shouldTransform(id: string, options: UnzenVitePluginOptionsSnapshot): boolean {
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

function normalizeDeclarationFile(value: unknown): string | undefined {
  if (value === undefined || value === false) return undefined;
  if (typeof value !== 'string') {
    throw new UnzenTypeGenerationError(
      'declarationFile must be a relative .d.ts asset path without parent traversal',
    );
  }
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
  const snapshot = snapshotVitePluginOptions(options);
  const declarationFile = snapshot.declarationFile;
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
      if (!shouldTransform(id, snapshot)) return null;
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

      if (snapshot.dependencyBundling) {
        return transformUnzenDefinitionsWithDependencies(
          code,
          id,
          snapshot.dependencyBundling,
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
