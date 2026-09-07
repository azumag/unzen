import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMiniflarePhaseTimer } from './helpers/miniflare-phase-timing.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('opt-in Miniflare phase timing', () => {
  it('does not log by default and preserves the operation result', async () => {
    vi.stubEnv('UNZEN_MINIFLARE_TIMING', '');
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    const measure = createMiniflarePhaseTimer('engine');
    const result = { value: 7 };
    expect(await measure('compile', async () => result)).toBe(result);
    expect(log).not.toHaveBeenCalled();
  });

  it('reports start and completion with monotonic elapsed time and no payload', async () => {
    vi.stubEnv('UNZEN_MINIFLARE_TIMING', '1');
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    const clock = vi.spyOn(performance, 'now').mockReturnValue(100);
    const measure = createMiniflarePhaseTimer('adapters');
    const operation = vi.fn(async () => {
      clock.mockReturnValue(112.5);
      return { secret: 'must-not-appear' };
    });
    await measure('startup', operation);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(2);
    const [start, end] = log.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(start).toMatchObject({ event: 'unzen_miniflare_phase', suite: 'adapters', phase: 'startup', status: 'started' });
    expect(end).toMatchObject({ ...start, status: 'passed', elapsedMs: 12.5 });
    expect(start.sample).toBe(end.sample);
    expect(JSON.stringify(log.mock.calls)).not.toContain('must-not-appear');
  });

  it.each([false, true])('preserves the exact failed operation when logging throws=%s', async (loggingThrows) => {
    vi.stubEnv('UNZEN_MINIFLARE_TIMING', '1');
    const log = vi.spyOn(console, 'info').mockImplementation(() => {
      if (loggingThrows) throw new Error('logger failed');
    });
    const original = new Error('secret exception details');
    const measure = createMiniflarePhaseTimer('engine');
    await expect(measure('request-verification', async () => { throw original; }))
      .rejects.toBe(original);
    expect(log).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(log.mock.calls[1][0])).status).toBe('failed');
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret exception details');
  });

  it('uses a distinct sample identity for each isolated runtime', async () => {
    vi.stubEnv('UNZEN_MINIFLARE_TIMING', '1');
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    await createMiniflarePhaseTimer('engine')('dispose', async () => {});
    await createMiniflarePhaseTimer('engine')('dispose', async () => {});
    expect(JSON.parse(String(log.mock.calls[0][0])).sample)
      .not.toBe(JSON.parse(String(log.mock.calls[2][0])).sample);
  });
});
