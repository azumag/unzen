export interface FinalOutputSnapshot {
  readonly tokens: readonly number[];
  readonly text: string;
}

type FinalOutputLabel = 'final segment output' | 'final span output';

const MAX_ARRAY_LENGTH = 0xffff_ffff;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  try {
    return !Array.isArray(value);
  } catch {
    return false;
  }
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function makeFinalOutputError(
  makeError: (message: string) => Error,
  suffix: string,
  label?: FinalOutputLabel,
): Error {
  if (label !== undefined) {
    return makeError(`${label}${suffix}`);
  }

  // The two existing callers historically expose different diagnostic prefixes.
  // Keep that compatibility when a caller omits an explicit label. This branch
  // executes only on invalid worker output; successful snapshots allocate no
  // diagnostic Error objects.
  const segmentError = makeError(`final segment output${suffix}`);
  if (segmentError.name === 'SpanPipelineError') {
    return makeError(`final span output${suffix}`);
  }
  return segmentError;
}

function readFinalOutputField(
  value: Record<string, unknown>,
  field: 'tokens' | 'text',
  makeError: (message: string) => Error,
  label?: FinalOutputLabel,
): unknown {
  try {
    return value[field];
  } catch {
    throw makeFinalOutputError(
      makeError,
      field === 'tokens' ? ' tokens must be an array' : ' text must be a string',
      label,
    );
  }
}

/**
 * Validate a worker-owned final output and detach it from executor-controlled
 * accessors, array mutation, and iteration hooks before the coordinator accepts it.
 */
export function snapshotFinalOutput(
  value: unknown,
  makeError: (message: string) => Error,
  label?: FinalOutputLabel,
): FinalOutputSnapshot {
  if (!isRecord(value)) {
    throw makeFinalOutputError(makeError, ' must be a non-null, non-array object', label);
  }

  // Capture each declared output field exactly once and in the historical order.
  // Runtime callers can provide getter/Proxy-backed objects even though the
  // protocol type is readonly; accessor failures must not escape this boundary.
  const tokens = readFinalOutputField(value, 'tokens', makeError, label);
  const text = readFinalOutputField(value, 'text', makeError, label);

  let tokensAreArray: boolean;
  try {
    tokensAreArray = Array.isArray(tokens);
  } catch {
    throw makeFinalOutputError(makeError, ' tokens must be an array', label);
  }
  if (!tokensAreArray) {
    throw makeFinalOutputError(makeError, ' tokens must be an array', label);
  }

  // Copy by numeric index rather than iteration. A worker-controlled array may
  // override Symbol.iterator; validation and retained output must observe the
  // same element values exactly once. Bound length/index traps as well so a
  // revoked or hostile array proxy cannot leak its exception.
  let length: unknown;
  try {
    length = (tokens as readonly unknown[]).length;
  } catch {
    throw makeFinalOutputError(makeError, ' tokens must be an array', label);
  }
  if (
    typeof length !== 'number' ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > MAX_ARRAY_LENGTH
  ) {
    throw makeFinalOutputError(makeError, ' tokens must be an array', label);
  }

  const ownedTokens = new Array<number>(length);
  for (let index = 0; index < length; index++) {
    let token: unknown;
    try {
      token = (tokens as readonly unknown[])[index];
    } catch {
      throw makeFinalOutputError(
        makeError,
        ' tokens must contain non-negative safe integers',
        label,
      );
    }
    if (!isNonNegativeSafeInteger(token)) {
      throw makeFinalOutputError(
        makeError,
        ' tokens must contain non-negative safe integers',
        label,
      );
    }
    ownedTokens[index] = token;
  }

  if (typeof text !== 'string') {
    throw makeFinalOutputError(makeError, ' text must be a string', label);
  }

  return Object.freeze({
    tokens: Object.freeze(ownedTokens),
    text,
  });
}
