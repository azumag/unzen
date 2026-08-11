import { MAX_EXECUTION_ARGUMENTS } from '@unzen/shared';

export interface QuickJsCallSnapshot {
  readonly code: string;
  readonly args: unknown[];
}

/**
 * Validate and own one QuickJS call before initialization or queueing.
 * QuickJS arguments cross a JSON boundary, so round-trip them now to prevent
 * later caller mutation and worker-side serialization failures.
 */
export function snapshotQuickJsCall(code: unknown, args: unknown): QuickJsCallSnapshot {
  if (typeof code !== 'string' || code.trim().length === 0) {
    throw new Error('QuickJS code must be a non-empty string');
  }
  if (!Array.isArray(args)) {
    throw new Error('QuickJS arguments must be an array');
  }

  const argumentCount: unknown = args.length;
  if (
    typeof argumentCount !== 'number'
    || !Number.isSafeInteger(argumentCount)
    || argumentCount < 0
    || argumentCount > MAX_EXECUTION_ARGUMENTS
  ) {
    throw new Error(`QuickJS supports at most ${MAX_EXECUTION_ARGUMENTS} arguments`);
  }

  try {
    const indexedSnapshot = new Array<unknown>(argumentCount);
    for (let index = 0; index < argumentCount; index += 1) {
      indexedSnapshot[index] = args[index];
    }
    const serialized = JSON.stringify(indexedSnapshot);
    if (typeof serialized !== 'string') {
      throw new Error('serialization returned no payload');
    }
    const jsonSnapshot: unknown = JSON.parse(serialized);
    if (!Array.isArray(jsonSnapshot)) {
      throw new Error('serialized arguments were not an array');
    }
    return { code, args: jsonSnapshot };
  } catch {
    throw new Error(
      `QuickJS arguments must be JSON-serializable and contain at most ${MAX_EXECUTION_ARGUMENTS} items`,
    );
  }
}
