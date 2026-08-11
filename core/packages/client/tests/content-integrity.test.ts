import { describe, expect, it } from 'vitest';
import {
  assertUnzenContentIntegrity,
  createUnzenContentCacheKey,
  digestUnzenContent,
  isValidUnzenContentHash,
} from '../src/content-integrity';

const ABC_HASH =
  'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

function encode(value: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(value);
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

describe('content integrity', () => {
  it('accepts only canonical lowercase SHA-256 identities', () => {
    expect(isValidUnzenContentHash(ABC_HASH)).toBe(true);
    expect(isValidUnzenContentHash(ABC_HASH.toUpperCase())).toBe(false);
    expect(isValidUnzenContentHash('sha256:abc')).toBe(false);
    expect(isValidUnzenContentHash(null)).toBe(false);
  });

  it('digests the exact response bytes', async () => {
    await expect(digestUnzenContent(encode('abc'), globalThis.crypto.subtle))
      .resolves.toBe(ABC_HASH);
  });

  it('fails closed for malformed, mismatched, or unverifiable content', async () => {
    await expect(assertUnzenContentIntegrity(encode('abc'), 'sha256:abc'))
      .rejects.toThrow('Invalid Unzen content hash');
    await expect(assertUnzenContentIntegrity(
      encode('tampered'),
      ABC_HASH,
    )).rejects.toThrow('Unzen content integrity check failed');
    await expect(assertUnzenContentIntegrity(encode('abc'), ABC_HASH, null))
      .rejects.toThrow('Web Crypto SHA-256 is unavailable');
  });

  it('keeps verified identities and legacy URL-only entries disjoint', () => {
    const url = 'https://example.com/module.wasm';
    const otherHash = `sha256:${'0'.repeat(64)}`;

    expect(createUnzenContentCacheKey(url)).toBe(`unverified:${url}`);
    expect(createUnzenContentCacheKey(url, ABC_HASH)).not.toBe(
      createUnzenContentCacheKey(url),
    );
    expect(createUnzenContentCacheKey(url, ABC_HASH)).not.toBe(
      createUnzenContentCacheKey(url, otherHash),
    );
  });
});
