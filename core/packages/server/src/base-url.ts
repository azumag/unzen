/** Validate and normalize the public prefix used in generated code URLs. */

const MAX_BASE_URL_BYTES = 2048;
const RELATIVE_BASE_ORIGIN = 'https://unzen.invalid';

function invalidBaseUrl(): TypeError {
  return new TypeError(
    'baseUrl must be an HTTP(S) URL or an origin-relative path without credentials, query, or fragment',
  );
}

export function normalizeUnzenBaseUrl(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw invalidBaseUrl();
  }
  const trimmed = value.trim();
  if (Buffer.byteLength(trimmed, 'utf8') > MAX_BASE_URL_BYTES) {
    throw invalidBaseUrl();
  }

  try {
    if (trimmed.startsWith('/')) {
      if (trimmed.startsWith('//')) throw invalidBaseUrl();
      const parsed = new URL(trimmed, `${RELATIVE_BASE_ORIGIN}/`);
      if (
        parsed.origin !== RELATIVE_BASE_ORIGIN
        || parsed.username !== ''
        || parsed.password !== ''
        || parsed.search !== ''
        || parsed.hash !== ''
      ) {
        throw invalidBaseUrl();
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
      throw invalidBaseUrl();
    }
    return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '');
  } catch (error) {
    if (error instanceof TypeError && error.message.startsWith('baseUrl must')) {
      throw error;
    }
    throw invalidBaseUrl();
  }
}
