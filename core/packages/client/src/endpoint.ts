const MAX_ENDPOINT_BYTES = 2048;
const RELATIVE_ENDPOINT_ORIGIN = 'https://unzen.invalid';

function invalidEndpoint(): TypeError {
  return new TypeError(
    'endpoint must be an HTTP(S) URL or an origin-relative path without credentials, query, or fragment',
  );
}

/** Validate and normalize a route prefix used by client HTTP components. */
export function normalizeUnzenEndpoint(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError('endpoint must be a non-empty string');
  }
  const trimmed = value.trim();
  if (new TextEncoder().encode(trimmed).byteLength > MAX_ENDPOINT_BYTES) {
    throw invalidEndpoint();
  }

  try {
    if (trimmed.startsWith('/')) {
      if (trimmed.startsWith('//')) throw invalidEndpoint();
      const parsed = new URL(trimmed, `${RELATIVE_ENDPOINT_ORIGIN}/`);
      if (
        parsed.origin !== RELATIVE_ENDPOINT_ORIGIN
        || parsed.username !== ''
        || parsed.password !== ''
        || parsed.search !== ''
        || parsed.hash !== ''
      ) {
        throw invalidEndpoint();
      }
      return parsed.pathname.replace(/\/+$/, '');
    }

    const parsed = new URL(trimmed);
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      || parsed.username !== ''
      || parsed.password !== ''
      || parsed.search !== ''
      || parsed.hash !== ''
    ) {
      throw invalidEndpoint();
    }
    return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '');
  } catch (error) {
    if (error instanceof TypeError && error.message.startsWith('endpoint must')) {
      throw error;
    }
    throw invalidEndpoint();
  }
}
