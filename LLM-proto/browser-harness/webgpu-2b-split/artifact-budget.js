export const BROWSER_SEGMENT_PREFERRED_MAX_BYTES = 256 * 1024 * 1024;
export const BROWSER_SEGMENT_ABSOLUTE_MAX_BYTES = 1024 * 1024 * 1024;

function diagnosticValue(value) {
  // Diagnostics must never invoke user-defined coercion hooks on malformed
  // runtime input. Preserve useful primitive rendering while describing
  // objects/functions structurally instead of calling String(value).
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return value;
    case 'number':
      if (Number.isNaN(value)) return 'NaN';
      if (value === Number.POSITIVE_INFINITY) return 'Infinity';
      if (value === Number.NEGATIVE_INFINITY) return '-Infinity';
      return `${value}`;
    case 'boolean':
      return value ? 'true' : 'false';
    case 'bigint':
      return `${value}n`;
    case 'undefined':
      return 'undefined';
    case 'symbol':
      return value.description === undefined ? 'Symbol' : `Symbol(${value.description})`;
    case 'function':
      return '[function]';
    case 'object':
    default:
      return '[object]';
  }
}

function requireRecord(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function segmentLabel(segment) {
  const index = segment.index;
  return `segment ${index === undefined || index === null ? '?' : diagnosticValue(index)}`;
}

function safeBytes(value, label) {
  // Manifest byte counts are an exact JSON contract. Reject numeric strings,
  // booleans, and other coercible values rather than normalizing them with
  // Number(), so runtime budget decisions cannot silently accept malformed
  // manifests.
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer: ${diagnosticValue(value)}`);
  }
  return value;
}

function positiveBytes(value, label) {
  const bytes = safeBytes(value, label);
  if (bytes === 0) {
    throw new Error(`${label} must be greater than zero`);
  }
  return bytes;
}

export function planSegmentArtifactBudget(segment, mode = 'absolute') {
  if (!['p0', 'absolute'].includes(mode)) {
    throw new Error(`unsupported browser artifact budget mode: ${diagnosticValue(mode)}`);
  }
  const validatedSegment = requireRecord(segment, 'segment artifact budget input');
  const label = segmentLabel(validatedSegment);
  const declaredBytes = safeBytes(validatedSegment.browserArtifactBytes, `${label} browserArtifactBytes`);
  const externalData = validatedSegment.externalData ?? [];
  if (!Array.isArray(externalData) || externalData.length === 0) {
    throw new Error(`${label} must declare external data`);
  }
  const externalDeclaredBytes = externalData.reduce(
    (sum, entry, index) => sum + safeBytes(entry?.bytes, `${label} externalData[${index}].bytes`),
    0,
  );
  const graphDeclaredBytes = declaredBytes - externalDeclaredBytes;
  if (!Number.isSafeInteger(graphDeclaredBytes) || graphDeclaredBytes <= 0) {
    throw new Error(
      `${label} browserArtifactBytes must exceed declared external-data bytes`,
    );
  }

  const requiredMaxBytes = mode === 'p0'
    ? BROWSER_SEGMENT_PREFERRED_MAX_BYTES
    : BROWSER_SEGMENT_ABSOLUTE_MAX_BYTES;
  if (declaredBytes > BROWSER_SEGMENT_ABSOLUTE_MAX_BYTES) {
    throw new Error(
      `${label} exceeds the absolute browser artifact limit: ${declaredBytes} > ${BROWSER_SEGMENT_ABSOLUTE_MAX_BYTES}`,
    );
  }
  if (declaredBytes > requiredMaxBytes) {
    throw new Error(
      `${label} exceeds ${mode} browser artifact budget: ${declaredBytes} > ${requiredMaxBytes}`,
    );
  }

  return {
    mode,
    declaredBytes,
    graphDeclaredBytes,
    externalDeclaredBytes,
    requiredMaxBytes,
    absoluteMaxBytes: BROWSER_SEGMENT_ABSOLUTE_MAX_BYTES,
    verdict: 'accepted',
  };
}

export function verifyActualSegmentArtifactBudget(plan, reports) {
  const validatedPlan = requireRecord(plan, 'artifact budget plan');
  if (!Array.isArray(reports)) {
    throw new Error('artifact reports must be an array');
  }

  // Own the caller-provided plan before validating it. Accessor/Proxy-backed
  // plans must not be able to return one value for validation and a different
  // value when the accepted result is constructed later.
  const planSnapshot = { ...validatedPlan };
  const declaredBytes = positiveBytes(planSnapshot.declaredBytes, 'artifact plan declaredBytes');
  const requiredMaxBytes = positiveBytes(
    planSnapshot.requiredMaxBytes,
    'artifact plan requiredMaxBytes',
  );
  const absoluteMaxBytes = positiveBytes(
    planSnapshot.absoluteMaxBytes,
    'artifact plan absoluteMaxBytes',
  );
  if (requiredMaxBytes > absoluteMaxBytes) {
    throw new Error('artifact plan requiredMaxBytes must not exceed absoluteMaxBytes');
  }
  if (declaredBytes > requiredMaxBytes || declaredBytes > absoluteMaxBytes) {
    throw new Error('artifact plan declaredBytes must not exceed runtime limits');
  }

  const actualBytes = reports.reduce((sum, report, index) => {
    return sum + safeBytes(report?.bytes, `artifact report[${index}].bytes`);
  }, 0);
  if (actualBytes !== declaredBytes) {
    throw new Error(
      `segment artifact actual byte size does not match manifest: ${actualBytes} != ${declaredBytes}`,
    );
  }
  if (actualBytes > requiredMaxBytes || actualBytes > absoluteMaxBytes) {
    throw new Error(`segment artifact actual byte size exceeds runtime budget: ${actualBytes}`);
  }
  return {
    ...planSnapshot,
    actualBytes,
    actualMatchesDeclared: true,
    verdict: 'accepted',
  };
}
