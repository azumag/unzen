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
});
