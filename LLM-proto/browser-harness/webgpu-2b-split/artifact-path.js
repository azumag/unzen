const WINDOWS_RESERVED_DEVICE_STEMS = new Set(['CON', 'PRN', 'AUX', 'NUL']);
const WINDOWS_RESERVED_PORT_PATTERN = /^(?:COM|LPT)(?:[1-9]|[¹²³])$/;

function isWindowsPathAlias(part) {
  if (part.endsWith('.') || part.endsWith(' ')) return true;
  const stem = part.split('.', 1)[0].toUpperCase();
  return WINDOWS_RESERVED_DEVICE_STEMS.has(stem) || WINDOWS_RESERVED_PORT_PATTERN.test(stem);
}

export function requireSafeArtifactRelativePath(value, label = 'artifact path') {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.startsWith('/')
    || value.includes('\\')
    || value.includes(':')
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`${label} must be a safe relative POSIX path`);
  }

  const parts = value.split('/');
  if (parts.some((part) => (
    part.length === 0
    || part === '.'
    || part === '..'
    || isWindowsPathAlias(part)
  ))) {
    throw new Error(`${label} must be a safe relative POSIX path`);
  }
  return value;
}

export function resolveArtifactUrl(splitRoot, relativePath, baseHref) {
  if (typeof splitRoot !== 'string' || splitRoot.length === 0) {
    throw new Error('splitRoot must be a non-empty string');
  }
  if (typeof baseHref !== 'string' || baseHref.length === 0) {
    throw new Error('baseHref must be a non-empty string');
  }
  const safePath = requireSafeArtifactRelativePath(relativePath);
  const root = splitRoot.endsWith('/') ? splitRoot : `${splitRoot}/`;
  let rootUrl;
  try {
    rootUrl = new URL(root, baseHref);
  } catch {
    throw new Error('splitRoot must resolve to a valid URL');
  }

  // Encode path components independently. Characters such as `?`, `#`, and
  // `%` are valid filename characters but must never be reinterpreted as URL
  // query/fragment/escape syntax while resolving manifest-controlled paths.
  const encodedPath = safePath
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
  return new URL(encodedPath, rootUrl).href;
}
