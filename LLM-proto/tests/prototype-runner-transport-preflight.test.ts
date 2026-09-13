import { describe, expect, it } from 'vitest';
import {
  AllowlistedPrototypeTransport,
  TwoWorkerPrototypeRunner,
} from '../src/two-worker-prototype.js';

const coordinatorUrl = 'https://coordinator.unzen.local';
const cdnUrl = 'https://cdn.unzen.local';

describe('prototype runner transport preflight', () => {
  it('checks connectability without appending transport history', () => {
    const transport = new AllowlistedPrototypeTransport([coordinatorUrl, cdnUrl]);

    expect(() => transport.assertConnectable(`${coordinatorUrl}/health`)).not.toThrow();
    expect(transport.connectionCount).toBe(0);

    expect(() => transport.assertConnectable('https://blocked.example/model.bin')).toThrow(
      'Connection outside prototype allowlist: https://blocked.example',
    );
    expect(transport.connectionCount).toBe(0);
  });

  it.each([
    ['coordinatorUrl', { coordinatorUrl: 'https://blocked.example' }],
    ['cdnUrl', { cdnUrl: 'https://blocked.example' }],
  ] as const)(
    'rejects non-allowlisted %s before request or worker side effects',
    async (_field, override) => {
      const transport = new AllowlistedPrototypeTransport([coordinatorUrl, cdnUrl]);
      const runner = new TwoWorkerPrototypeRunner({ transport });

      await expect(runner.run({
        prompt: 'rejected before execution',
        ...override,
      })).rejects.toThrow('Connection outside prototype allowlist');
      expect(transport.connectionCount).toBe(0);

      const report = await runner.run({ prompt: 'first accepted execution' });
      expect(report.requestId).toBe('proto-1');
      expect(report.matchesReference).toBe(true);
      expect(report.segments[1]?.retryCount).toBe(1);
      expect(report.segments[0]?.workerMetadata.cachedSegments).toEqual([0]);
      expect(report.segments[1]?.workerMetadata.cachedSegments).toEqual([1]);
    },
  );

  it('preserves valid custom allowlisted runner URLs and connection logging', async () => {
    const customCoordinatorUrl = 'https://coordinator.example.test';
    const customCdnUrl = 'https://cdn.example.test';
    const transport = new AllowlistedPrototypeTransport([
      customCoordinatorUrl,
      customCdnUrl,
    ]);
    const runner = new TwoWorkerPrototypeRunner({ transport });

    const report = await runner.run({
      prompt: 'custom transport remains valid',
      coordinatorUrl: customCoordinatorUrl,
      cdnUrl: customCdnUrl,
    });

    expect(report.requestId).toBe('proto-1');
    expect(report.matchesReference).toBe(true);
    expect(report.transport.connections).toEqual([
      customCoordinatorUrl,
      customCdnUrl,
      customCoordinatorUrl,
      customCdnUrl,
      customCoordinatorUrl,
      customCdnUrl,
      customCoordinatorUrl,
    ]);
  });
});
