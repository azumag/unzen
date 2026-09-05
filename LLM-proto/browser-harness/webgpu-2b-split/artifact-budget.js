export const BROWSER_SEGMENT_PREFERRED_MAX_BYTES = 256 * 1024 * 1024;
export const BROWSER_SEGMENT_ABSOLUTE_MAX_BYTES = 1024 * 1024 * 1024;

function safeBytes(value, label) {
  const bytes = Number(value);
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new Error(`${label} must be a non-negative safe integer: ${value}`);
  }
  return bytes;
}

export function planSegmentArtifactBudget(segment, mode = 'absolute') {
  if (!['p0', 'absolute'].includes(mode)) {
    throw new Error(`unsupported browser artifact budget mode: ${mode}`);
  }
  const declaredBytes = safeBytes(segment?.browserArtifactBytes, `segment ${segment?.index ?? '?'} browserArtifactBytes`);
  const externalData = segment?.externalData ?? [];
  if (!Array.isArray(externalData) || externalData.length === 0) {
    throw new Error(`segment ${segment?.index ?? '?'} must declare external data`);
  }
  const externalDeclaredBytes = externalData.reduce(
    (sum, entry, index) => sum + safeBytes(entry?.bytes, `segment ${segment?.index ?? '?'} externalData[${index}].bytes`),
    0,
  );
  const graphDeclaredBytes = declaredBytes - externalDeclaredBytes;
  if (!Number.isSafeInteger(graphDeclaredBytes) || graphDeclaredBytes <= 0) {
    throw new Error(
      `segment ${segment?.index ?? '?'} browserArtifactBytes must exceed declared external-data bytes`,
    );
  }

  const requiredMaxBytes = mode === 'p0'
    ? BROWSER_SEGMENT_PREFERRED_MAX_BYTES
    : BROWSER_SEGMENT_ABSOLUTE_MAX_BYTES;
  if (declaredBytes > BROWSER_SEGMENT_ABSOLUTE_MAX_BYTES) {
    throw new Error(
      `segment ${segment?.index ?? '?'} exceeds the absolute browser artifact limit: ${declaredBytes} > ${BROWSER_SEGMENT_ABSOLUTE_MAX_BYTES}`,
    );
  }
  if (declaredBytes > requiredMaxBytes) {
    throw new Error(
      `segment ${segment?.index ?? '?'} exceeds ${mode} browser artifact budget: ${declaredBytes} > ${requiredMaxBytes}`,
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
  const actualBytes = reports.reduce((sum, report, index) => {
    return sum + safeBytes(report?.bytes, `artifact report[${index}].bytes`);
  }, 0);
  if (actualBytes !== plan.declaredBytes) {
    throw new Error(
      `segment artifact actual byte size does not match manifest: ${actualBytes} != ${plan.declaredBytes}`,
    );
  }
  if (actualBytes > plan.requiredMaxBytes || actualBytes > plan.absoluteMaxBytes) {
    throw new Error(`segment artifact actual byte size exceeds runtime budget: ${actualBytes}`);
  }
  return {
    ...plan,
    actualBytes,
    actualMatchesDeclared: true,
    verdict: 'accepted',
  };
}
