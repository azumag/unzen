import { describe, expect, it, vi } from 'vitest';
import { CodeFetcher } from '../src/code-fetcher';
import { snapshotMoonBitExecutionOptions } from '../src/moonbit-call';
import { snapshotQuickJsExecutionOptions } from '../src/quickjs-call';
import { registerUnzenCacheWorkerWith } from '../src/unzen-cache';

function revokedObjectProxy(): object {
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  return revoked.proxy;
}

describe('Core client option-container trust boundary', () => {
  it('fails closed on revoked QuickJS execution option proxies', () => {
    expect(() => snapshotQuickJsExecutionOptions(revokedObjectProxy()))
      .toThrow('QuickJS execution options must be an object');
  });

  it('fails closed on revoked MoonBit execution option proxies', () => {
    expect(() => snapshotMoonBitExecutionOptions(revokedObjectProxy()))
      .toThrow('MoonBit execution options must be an object');
  });

  it('fails closed on revoked CodeFetcher option proxies before later work', () => {
    expect(() => new CodeFetcher('https://example.com', revokedObjectProxy() as never))
      .toThrow('CodeFetcher options must be an object');
  });

  it('fails closed on revoked cache-worker option proxies before register()', async () => {
    const register = vi.fn();

    await expect(registerUnzenCacheWorkerWith(
      { register },
      revokedObjectProxy() as never,
    )).rejects.toThrow('Unzen cache worker options must be an object');
    expect(register).not.toHaveBeenCalled();
  });

  it('keeps ordinary arrays in the existing invalid-container diagnostics', async () => {
    expect(() => snapshotQuickJsExecutionOptions([]))
      .toThrow('QuickJS execution options must be an object');
    expect(() => snapshotMoonBitExecutionOptions([]))
      .toThrow('MoonBit execution options must be an object');
    expect(() => new CodeFetcher('https://example.com', [] as never))
      .toThrow('CodeFetcher options must be an object');

    const register = vi.fn();
    await expect(registerUnzenCacheWorkerWith({ register }, [] as never))
      .rejects.toThrow('Unzen cache worker options must be an object');
    expect(register).not.toHaveBeenCalled();
  });
});
