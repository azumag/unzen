import { describe, expect, it, vi } from 'vitest';
import { ownSession } from '../browser-harness/webgpu-2b-split/execution-lifecycle.js';

describe('browser ORT session ownership runtime boundary', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['number', 1],
    ['string', 'session'],
    ['boolean', true],
  ])('rejects a malformed %s session before retaining it', (_name, session) => {
    expect(() => ownSession(session as unknown as { release(): Promise<void> })).toThrow(
      'ORT session must be an object',
    );
  });

  it.each([
    ['missing', {}],
    ['null', { release: null }],
    ['string', { release: 'release' }],
  ])('rejects a %s release capability at ownership time', (_name, session) => {
    expect(() => ownSession(session as unknown as { release(): Promise<void> })).toThrow(
      'ORT session release must be a function',
    );
  });

  it('snapshots the accepted release method while retaining the exact session', async () => {
    const acceptedRelease = vi.fn(async function (this: { marker: string }) {
      expect(this.marker).toBe('owned');
    });
    const replacementRelease = vi.fn(async () => {});
    const session = { marker: 'owned', release: acceptedRelease };
    const owner = ownSession(session);

    session.release = replacementRelease;

    expect(owner.session).toBe(session);
    await expect(owner.release()).resolves.toBe(true);
    await expect(owner.release()).resolves.toBe(false);
    expect(acceptedRelease).toHaveBeenCalledTimes(1);
    expect(replacementRelease).not.toHaveBeenCalled();
  });

  it('preserves a release rejection as the cleanup root cause', async () => {
    const releaseError = new Error('release exploded');
    const owner = ownSession({
      release: vi.fn(async () => {
        throw releaseError;
      }),
    });

    await expect(owner.release()).rejects.toBe(releaseError);
    expect(owner.released).toBe(true);
    await expect(owner.release()).resolves.toBe(false);
  });
});
