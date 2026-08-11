import type { SandboxExecutor } from './sandbox-executor';
import {
  normalizeMoonBitImportedStringConstants,
  type MoonBitImportedStringConstants,
} from './moonbit-compile-options';
import { normalizeWorkerUrl } from './worker-executor-options';
import { normalizeUnzenEndpoint } from './endpoint';

export type UnzenClientMode = 'production' | 'development' | 'browser-only';

export type NormalizedSandboxSelection =
  | { readonly kind: 'custom'; readonly executor: SandboxExecutor }
  | { readonly kind: 'worker'; readonly workerUrl: string };

export type NormalizedMoonBitSandboxSelection =
  | { readonly kind: 'custom'; readonly executor: SandboxExecutor }
  | {
      readonly kind: 'worker';
      readonly workerUrl: string;
      readonly importedStringConstants: MoonBitImportedStringConstants;
    }
  | {
      readonly kind: 'main-thread';
      readonly importedStringConstants: MoonBitImportedStringConstants;
    };

export interface NormalizedUnzenClientOptions {
  readonly endpoint: string;
  readonly mode: UnzenClientMode;
  readonly sandbox: NormalizedSandboxSelection;
  readonly moonbitSandbox: NormalizedMoonBitSandboxSelection;
}

function readOption(record: Record<string, unknown>, name: string): unknown {
  try {
    return record[name];
  } catch {
    throw new TypeError(`UnzenClient option ${name} could not be read`);
  }
}

function normalizeMode(value: unknown): UnzenClientMode {
  if (value === undefined) return 'production';
  if (value !== 'production' && value !== 'development' && value !== 'browser-only') {
    throw new TypeError('mode must be production, development, or browser-only');
  }
  return value;
}

/** Snapshot an injected executor's callable surface while preserving method `this`. */
function normalizeSandboxExecutor(name: string, value: unknown): SandboxExecutor {
  if (
    (typeof value !== 'object' || value === null)
    && typeof value !== 'function'
  ) {
    throw new TypeError(`${name} must implement execute() and dispose()`);
  }

  const target = value as object;
  let execute: unknown;
  let dispose: unknown;
  let prepare: unknown;
  let isReady: unknown;
  try {
    const record = value as Record<string, unknown>;
    execute = record.execute;
    dispose = record.dispose;
    prepare = record.prepare;
    isReady = record.isReady;
  } catch {
    throw new TypeError(`${name} methods could not be read`);
  }

  if (typeof execute !== 'function' || typeof dispose !== 'function') {
    throw new TypeError(`${name} must implement execute() and dispose()`);
  }
  if (prepare !== undefined && typeof prepare !== 'function') {
    throw new TypeError(`${name}.prepare must be a function when provided`);
  }
  if (isReady !== undefined && typeof isReady !== 'function') {
    throw new TypeError(`${name}.isReady must be a function when provided`);
  }

  return {
    execute(code, args, options) {
      return Reflect.apply(execute, target, [code, args, options]) as Promise<unknown>;
    },
    dispose() {
      Reflect.apply(dispose, target, []);
    },
    ...(prepare !== undefined && {
      prepare(code: string, signal?: AbortSignal, expectedHash?: string) {
        return Reflect.apply(prepare, target, [code, signal, expectedHash]) as Promise<unknown>;
      },
    }),
    ...(isReady !== undefined && {
      isReady() {
        return Reflect.apply(isReady, target, []) as boolean;
      },
    }),
  };
}

/** Validate and snapshot constructor options before creating any component. */
export function normalizeUnzenClientOptions(value: unknown): NormalizedUnzenClientOptions {
  let record: Record<string, unknown>;
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new TypeError('UnzenClient options must be an object');
    }
    record = value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof TypeError && error.message === 'UnzenClient options must be an object') {
      throw error;
    }
    throw new TypeError('UnzenClient options must be an object');
  }

  const endpoint = normalizeUnzenEndpoint(readOption(record, 'endpoint'));
  const mode = normalizeMode(readOption(record, 'mode'));

  const customSandbox = readOption(record, 'sandbox');
  let sandbox: NormalizedSandboxSelection;
  if (customSandbox !== undefined) {
    sandbox = {
      kind: 'custom',
      executor: normalizeSandboxExecutor('sandbox', customSandbox),
    };
  } else {
    const workerUrl = readOption(record, 'workerUrl');
    if (workerUrl === undefined) {
      throw new TypeError(
        'UnzenClient requires either workerUrl or sandbox option. '
        + 'Use workerUrl for browser execution or provide a custom SandboxExecutor.',
      );
    }
    sandbox = { kind: 'worker', workerUrl: normalizeWorkerUrl(workerUrl) };
  }

  const customMoonBitSandbox = readOption(record, 'moonbitSandbox');
  let moonbitSandbox: NormalizedMoonBitSandboxSelection;
  if (customMoonBitSandbox !== undefined) {
    moonbitSandbox = {
      kind: 'custom',
      executor: customMoonBitSandbox === customSandbox && sandbox.kind === 'custom'
        ? sandbox.executor
        : normalizeSandboxExecutor('moonbitSandbox', customMoonBitSandbox),
    };
  } else {
    const moonbitWorkerUrl = readOption(record, 'moonbitWorkerUrl');
    const importedStringConstants = normalizeMoonBitImportedStringConstants(
      readOption(record, 'moonbitImportedStringConstants') as
        MoonBitImportedStringConstants | undefined,
    );
    moonbitSandbox = moonbitWorkerUrl === undefined
      ? { kind: 'main-thread', importedStringConstants }
      : {
          kind: 'worker',
          workerUrl: normalizeWorkerUrl(moonbitWorkerUrl),
          importedStringConstants,
        };
  }

  return { endpoint, mode, sandbox, moonbitSandbox };
}
