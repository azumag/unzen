/** Byte-level SHA-256 helpers shared by every downloaded Unzen payload. */

const SHA256_CONTENT_HASH = /^sha256:[a-f0-9]{64}$/;

/** Whether a value is the canonical content identity emitted by UnzenServer. */
export function isValidUnzenContentHash(value: unknown): value is string {
  return typeof value === 'string' && SHA256_CONTENT_HASH.test(value);
}

/** Digest raw response bytes without a text decode/re-encode round trip. */
export async function digestUnzenContent(
  bytes: ArrayBuffer,
  subtle: Pick<SubtleCrypto, 'digest'>,
): Promise<string> {
  const digest = await subtle.digest('SHA-256', bytes);
  const hex = Array.from(
    new Uint8Array(digest),
    (value) => value.toString(16).padStart(2, '0'),
  ).join('');
  return `sha256:${hex}`;
}

/**
 * Fail closed unless raw payload bytes match the manifest identity.
 *
 * Verification happens before decoding, compiling, or caching. Hashing the
 * original bytes is important: decoding malformed UTF-8 and encoding it again
 * could otherwise verify a representation different from the one received.
 */
export async function assertUnzenContentIntegrity(
  bytes: ArrayBuffer,
  expectedHash: string,
  subtle: Pick<SubtleCrypto, 'digest'> | null | undefined = globalThis.crypto?.subtle,
): Promise<void> {
  if (!isValidUnzenContentHash(expectedHash)) {
    throw new Error('Invalid Unzen content hash');
  }
  if (!subtle) {
    throw new Error('Web Crypto SHA-256 is unavailable');
  }

  const actualHash = await digestUnzenContent(bytes, subtle);
  if (actualHash !== expectedHash) {
    throw new Error('Unzen content integrity check failed');
  }
}

/** Cache identity keeps verified and legacy unverified fetches disjoint. */
export function createUnzenContentCacheKey(url: string, expectedHash?: string): string {
  return expectedHash === undefined
    ? `unverified:${url}`
    : `verified:${expectedHash}:${url}`;
}
