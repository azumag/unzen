import { describe, expect, it } from 'vitest';
import { AllowlistedPrototypeTransport } from '../src/two-worker-prototype.js';

describe('AllowlistedPrototypeTransport origin contract', () => {
  it('canonicalizes configured URLs to origins and deduplicates them', () => {
    const transport = new AllowlistedPrototypeTransport([
      'https://coordinator.example/api/',
      'https://cdn.example:8443/models/v1/',
      'https://cdn.example:8443/another/path',
    ]);

    expect(transport.allowlist).toEqual([
      'https://coordinator.example',
      'https://cdn.example:8443',
    ]);

    expect(() => transport.connect('https://coordinator.example/checkpoint/request-1')).not.toThrow();
    expect(() => transport.connect('https://cdn.example:8443/weights/segment-0.bin')).not.toThrow();
    expect(() => transport.connect('https://cdn.example/weights/segment-0.bin')).toThrow(
      /outside prototype allowlist/,
    );
  });

  it('takes an immutable snapshot instead of retaining caller-owned allowlist state', () => {
    const configuredOrigins = ['https://coordinator.example'];
    const transport = new AllowlistedPrototypeTransport(configuredOrigins);

    configuredOrigins.push('https://worker-peer.example');

    expect(transport.allowlist).toEqual(['https://coordinator.example']);
    expect(Object.isFrozen(transport.allowlist)).toBe(true);
    expect(() => transport.connect('https://worker-peer.example/direct')).toThrow(
      /outside prototype allowlist/,
    );
    expect(() => (transport.allowlist as string[]).push('https://worker-peer.example')).toThrow();
    expect(transport.allowlist).toEqual(['https://coordinator.example']);
  });

  it('fails closed when an allowlist entry has no valid network origin', () => {
    expect(() => new AllowlistedPrototypeTransport(['/relative/path'])).toThrow(
      /Invalid prototype allowlist URL/,
    );
    expect(() => new AllowlistedPrototypeTransport(['data:text/plain,hello'])).toThrow(
      /must have a network origin/,
    );
  });

  it.each([
    null,
    undefined,
    42,
    'https://coordinator.example',
    {},
    Symbol('allowlist'),
    () => undefined,
  ])('rejects malformed top-level allowlists before iteration', (allowedOrigins) => {
    expect(() => new AllowlistedPrototypeTransport(
      allowedOrigins as unknown as readonly string[],
    )).toThrow(/prototype allowedOrigins must be an array/);
  });

  it.each([null, undefined, 42, {}, [], Symbol('origin'), '', '   '])(
    'rejects malformed allowlist entries with a deterministic validation error',
    (origin) => {
      expect(() => new AllowlistedPrototypeTransport([
        origin as unknown as string,
      ])).toThrow(/prototype allowlist URL at index 0 must be a non-empty string/);
    },
  );

  it('rejects malformed connection URLs before mutating the connection log', () => {
    const transport = new AllowlistedPrototypeTransport(['https://coordinator.example']);
    transport.connect('https://coordinator.example/healthy');
    const expectedConnections = ['https://coordinator.example'];

    const malformedUrls: readonly unknown[] = [
      null,
      undefined,
      42,
      {},
      [],
      Symbol('connection'),
      '',
      '   ',
    ];
    for (const malformedUrl of malformedUrls) {
      expect(() => transport.connect(malformedUrl as string)).toThrow(
        /prototype connection URL must be a non-empty string/,
      );
      expect(transport.connections).toEqual(expectedConnections);
    }

    expect(() => transport.connect('/relative/path')).toThrow(
      /Invalid prototype connection URL/,
    );
    expect(transport.connections).toEqual(expectedConnections);

    expect(() => transport.connect('https://outside.example/path')).toThrow(
      /outside prototype allowlist/,
    );
    expect(transport.connections).toEqual(expectedConnections);
  });
});
