export interface FinalOutputSnapshot {
  readonly tokens: readonly number[];
  readonly text: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Validate a worker-owned final output and detach it from executor-controlled
 * accessors, array mutation, and iteration hooks before the coordinator accepts it.
 */
export function snapshotFinalOutput(
  value: unknown,
  label: 'final segment output' | 'final span output',
  makeError: (message: string) => Error,
): FinalOutputSnapshot {
  if (!isRecord(value)) {
    throw makeError(`${label} must be a non-null, non-array object`);
  }

  // Capture each declared output field exactly once. Runtime callers can provide
  // getter/Proxy-backed objects even though the protocol type is readonly.
  const tokens = value.tokens;
  const text = value.text;

  if (!Array.isArray(tokens)) {
    throw makeError(`${label} tokens must be an array`);
  }

  // Copy by numeric index rather than iteration. A worker-controlled array may
  // override Symbol.iterator; validation and retained output must observe the
  // same element values exactly once.
  const length = tokens.length;
  const ownedTokens = new Array<number>(length);
  for (let index = 0; index < length; index++) {
    const token = tokens[index];
    if (!isNonNegativeSafeInteger(token)) {
      throw makeError(`${label} tokens must contain non-negative safe integers`);
    }
    ownedTokens[index] = token;
  }

  if (typeof text !== 'string') {
    throw makeError(`${label} text must be a string`);
  }

  return Object.freeze({
    tokens: Object.freeze(ownedTokens),
    text,
  });
}
